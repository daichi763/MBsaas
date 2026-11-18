// 操作の記録の画面（Sprint 31 w31-audit: #9988。API は src/audit-logs.ts）
// - 管理画面（admin.js の #audit-logs。会社管理者だけ）: CSV の書き出し・管理の操作・シフトと精算の操作・ログインを、新しい順に1つの一覧で出す
// - 本部画面（hq.js の企業詳細）: 同じ一覧を「企業の操作の記録」として開く（開いたこと・書き出したことは本部の操作の履歴に残る）
// - 画面で作る CSV（請求前確認・ログイン案内）を書き出したら logClientExport で記録に残す（管理画面の4ロール）
;(function () {
  const IS_HQ = location.pathname.startsWith('/hq')
  const CARD = IS_HQ ? 'bg-hq-800 border border-hq-700 rounded-xl p-4' : 'card p-4'
  const MUTED = IS_HQ ? 'text-hq-400' : 'text-neutral-500'
  const TEXT = IS_HQ ? 'text-hq-100' : 'text-neutral-800'
  const BORDER = IS_HQ ? 'border-hq-700' : 'border-neutral-100'
  const INP = IS_HQ ? 'class="inp text-sm" style="background:rgb(var(--color-hq-800));border-color:rgb(var(--color-hq-700));color:rgb(var(--color-on-primary))"' : 'class="inp text-sm"'
  const CAT_BADGE = { csv: 'badge-blue', staff: 'badge-green', admin: 'badge-yellow', settings: 'badge-purple', master: 'badge-gray', notice: 'badge-blue', shift: 'badge-green', login: 'badge-gray' }
  const CAT_ICON = { csv: 'fa-file-csv', staff: 'fa-user-pen', admin: 'fa-user-shield', settings: 'fa-gear', master: 'fa-briefcase', notice: 'fa-bullhorn', shift: 'fa-calendar-days', login: 'fa-right-to-bracket' }
  // 表示先ごとの状態（管理画面は #app、本部は企業詳細の欄）
  const ST = { host: '', api: '', kind: '', actor: '', from: '', to: '', items: [], next: null, options: null, loading: false }

  const fmtAt = (s) => (s ? dayjs(String(s).replace(' ', 'T')).format('YYYY/M/D HH:mm') : '')
  const params = (extra) => Object.fromEntries(Object.entries({ kind: ST.kind, actor: ST.actor, from: ST.from, to: ST.to, ...(extra || {}) }).filter(([, v]) => v !== '' && v != null))

  function changeHtml(ch) {
    if (ch.s) return `<li><span class="${MUTED}">${esc(ch.l)}:</span> 変更あり<span class="${MUTED}">（値は残していません）</span></li>`
    return `<li><span class="${MUTED}">${esc(ch.l)}:</span> ${esc(ch.b == null ? '（なし）' : ch.b)} <i class="fas fa-arrow-right text-4xs ${MUTED}"></i> ${esc(ch.a == null ? '（なし）' : ch.a)}</li>`
  }
  function itemHtml(i) {
    const badge = i.failed ? 'badge-red' : (CAT_BADGE[i.category] || 'badge-gray')
    return `<li class="py-2.5 border-b ${BORDER} last:border-b-0">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-xs ${MUTED} whitespace-nowrap tabular-nums">${esc(fmtAt(i.at))}</span>
        <span class="badge ${badge}"><i class="fas ${CAT_ICON[i.category] || 'fa-circle'} mr-0.5"></i>${esc(i.category_label)}</span>
        <span class="font-bold text-sm ${TEXT}">${esc(i.label)}</span>
        <span class="text-xs ${MUTED}"><i class="fas fa-user text-4xs mr-0.5"></i>${esc(i.actor)}${i.actor_role && !i.hq ? `（${esc(i.actor_role)}）` : ''}</span>
        ${i.ip ? `<span class="text-2xs ${MUTED} font-mono ml-auto" title="接続元">${esc(i.ip)}</span>` : ''}
      </div>
      ${i.target ? `<p class="text-xs ${TEXT} mt-0.5">${esc(i.target)}</p>` : ''}
      ${i.lines.length ? `<ul class="text-xs ${MUTED} mt-0.5 space-y-0.5 break-all">${i.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${i.changes.length ? `<ul class="text-xs mt-1 space-y-0.5 pl-2 border-l-2 ${IS_HQ ? 'border-hq-600 text-hq-200' : 'border-neutral-200 text-neutral-700'} break-all">${i.changes.map(changeHtml).join('')}</ul>` : ''}
    </li>`
  }
  function listHtml() {
    if (!ST.items.length) return `<p class="text-sm ${MUTED} py-6 text-center">条件に合う記録はありません。</p>`
    return `<ul>${ST.items.map(itemHtml).join('')}</ul>
      ${ST.next ? `<div class="text-center mt-3"><button type="button" class="btn ${IS_HQ ? 'btn-dark-outline' : 'btn-outline'} text-sm" data-action="auditMore"><i class="fas fa-angles-down"></i>さらに${Number(ST.options?.page_size) || 50}件を読み込む</button></div>`
        : `<p class="text-2xs ${MUTED} text-center mt-3">これより前の記録はありません（記録は1年間残します）</p>`}`
  }
  function filtersHtml() {
    const o = ST.options || { categories: [], actors: [] }
    const chip = (k, l) => `<button type="button" class="px-2.5 py-1 rounded-full text-xs border whitespace-nowrap ${ST.kind === k
      ? (IS_HQ ? 'border-hq-accent-500 text-hq-accent-300' : 'bg-primary-600 border-primary-600 text-white')
      : (IS_HQ ? 'border-hq-600 text-hq-400' : 'bg-surface border-neutral-200 text-neutral-600')}" data-action="auditKind" data-kind="${esc(k)}">${esc(l)}</button>`
    return `<div class="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="種類">${chip('', 'すべて')}${o.categories.map(([k, l]) => chip(k, l)).join('')}</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
        <label class="text-xs ${MUTED}">期間（から）<input type="date" id="audit-from" ${INP} value="${esc(ST.from)}"></label>
        <label class="text-xs ${MUTED}">期間（まで）<input type="date" id="audit-to" ${INP} value="${esc(ST.to)}"></label>
        <label class="text-xs ${MUTED} col-span-2 sm:col-span-1">操作した人<select id="audit-actor" ${INP}><option value="">すべての人</option>${o.actors.map(a => `<option value="${Number(a.user_id)}" ${String(ST.actor) === String(a.user_id) ? 'selected' : ''}>${esc(a.name)}（${esc(a.role_label || '')}${a.active ? '' : '・停止'}）</option>`).join('')}</select></label>
        <div class="flex gap-2 col-span-2 sm:col-span-1">
          <button type="button" class="btn ${IS_HQ ? 'btn-dark-outline' : 'btn-outline'} text-sm flex-1" data-action="auditSearch"><i class="fas fa-magnifying-glass"></i>絞り込む</button>
          <button type="button" class="btn ${IS_HQ ? 'btn-dark-outline' : 'btn-primary'} text-sm flex-1" data-action="auditExport" title="表示中の条件で、新しい順に最大${Number(o.csv_limit) || 2000}件"><i class="fas fa-file-csv"></i>CSV</button>
        </div>
      </div>
      <p class="text-2xs ${MUTED} mt-2">ログインの「操作した人」はログインした本人です。スタッフの操作（打刻・日報）は、それぞれの画面の履歴で確かめられます。CSV は表示中の条件で、新しい順に最大${Number(o.csv_limit) || 2000}件を出します（この書き出しも記録に残ります）。</p>`
  }
  function frameHtml() {
    return `<div class="${CARD} mb-3" id="audit-filters">${filtersHtml()}</div>
      <div class="${CARD}" id="audit-list"><div class="flex justify-center py-10"><span class="spin"></span></div></div>`
  }
  async function loadPage(more) {
    const box = document.getElementById('audit-list'); if (!box || ST.loading) return
    ST.loading = true
    try {
      const d = (await axios.get(ST.api, { params: params(more && ST.next ? { cursor: ST.next } : {}) })).data
      ST.items = more ? ST.items.concat(d.items || []) : (d.items || [])
      ST.next = d.next_cursor || null
      box.innerHTML = listHtml()
    } catch (e) {
      box.innerHTML = `<p class="text-sm text-danger-500">${esc(errMsg(e, '操作の記録を読み込めませんでした'))} <button type="button" class="btn btn-outline text-xs ml-2" data-action="auditSearch">再読み込み</button></p>`
    } finally { ST.loading = false }
  }
  async function open(hostId, api) {
    const host = document.getElementById(hostId); if (!host) return
    ST.host = hostId; ST.api = api; ST.items = []; ST.next = null
    if (!ST.options || ST.options.__api !== api) {
      try { ST.options = { ...(await axios.get(api + '/options')).data, __api: api } } catch (e) { host.innerHTML = `<p class="text-sm text-danger-500">${esc(errMsg(e, '読み込めませんでした'))}</p>`; return }
    }
    host.innerHTML = frameHtml()
    await loadPage(false)
  }
  function readFilters() {
    const v = (id) => ((document.getElementById(id) || {}).value || '').trim()
    ST.from = v('audit-from'); ST.to = v('audit-to'); ST.actor = v('audit-actor')
  }

  delegate('auditKind', (el) => {
    readFilters(); ST.kind = el.dataset.kind || ''
    const f = document.getElementById('audit-filters'); if (f) f.innerHTML = filtersHtml()
    loadPage(false)
  })
  delegate('auditSearch', (el) => withSubmitLock(el, async () => {
    readFilters()
    if (ST.from && ST.to && ST.from > ST.to) { toast('開始日は終了日より前にしてください'); return }
    await loadPage(false)
  }))
  delegate('auditMore', (el) => withSubmitLock(el, () => loadPage(true)))
  delegate('auditExport', (el) => withSubmitLock(el, async () => {
    readFilters()
    try {
      const res = await axios.get(ST.api + '/export', { params: params(), responseType: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(res.data)
      a.download = `audit_logs_${dayjs().format('YYYYMMDD')}.csv`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 10000)
      toast(res.headers['x-csv-truncated'] === '1' ? `新しい${Number(ST.options?.csv_limit) || 2000}件までを書き出しました。期間を区切って書き出してください` : 'CSVをダウンロードしました')
      // 管理画面では、この書き出しの記録が一覧の先頭に入るので読み直す
      if (!IS_HQ) loadPage(false)
    } catch (e) {
      let msg = '書き出せませんでした'
      try { if (e.response && e.response.data instanceof Blob) msg = JSON.parse(await e.response.data.text()).error || msg } catch { }
      toast(msg)
    }
  }))

  // 管理画面（#audit-logs）
  window.renderAuditLogs = async function () {
    const $app = document.getElementById('app')
    if (!hasPerm('audit_logs.view')) {
      $app.innerHTML = '<p class="text-center text-neutral-400 py-10">操作の記録は会社管理者だけが見られます。</p>'
      return
    }
    $app.innerHTML = `
      <div class="mb-4">
        <h2 class="text-xl font-bold text-neutral-900"><i class="fas fa-file-shield text-primary-600 mr-1"></i>操作の記録</h2>
        <p class="text-xs text-neutral-500 mt-1">だれが・いつ・何をしたかを新しい順に出します。CSV・ファイルの書き出し（条件・行数）、スタッフ・従業員の情報の変更（前後の値。口座などは「変更あり」だけ）、管理者・ログインの発行、設定・案件・クライアント・お知らせの変更、シフト・精算の操作、ログインの成功・失敗をまとめて見られます。記録は1年間残します。</p>
      </div>
      <div id="audit-host"></div>`
    await open('audit-host', '/api/admin/audit-logs')
  }

  // 本部の企業詳細（hq.js の renderCompanyDetail の欄）。開いたときに読む（開いたことは本部の操作の履歴に残る）
  window.renderHqCompanyAuditLogs = function (hostId, cid) {
    const host = document.getElementById(hostId); if (!host) return
    ST.kind = ''; ST.actor = ''; ST.from = ''; ST.to = ''
    open(hostId, `/api/hq/companies/${Number(cid)}/audit-logs`)
  }
  delegate('hqAuditLogsOpen', (el) => withSubmitLock(el, async () => {
    const hostId = el.dataset.host
    el.closest('[data-audit-intro]')?.remove()
    window.renderHqCompanyAuditLogs(hostId, Number(el.dataset.cid))
  }))

  // 画面で作る CSV を書き出したことを残す（失敗しても書き出しは止めない。本部の閲覧中は書き込めないので残らない）
  window.logClientExport = function (kind, info) {
    if (IS_HQ) return
    const body = { kind, ...(info || {}) }
    try { axios.post('/api/admin/export-logs', body).catch(() => { }) } catch { }
  }
})()
