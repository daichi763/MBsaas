// =========================================================
// スタッフ: 打刻履歴（日付ごとのタイムライン）と打刻修正申請
// docs/spec_attendance_correction.md 4章・6.2。staff.js の後に読み込む（#attendance）
// =========================================================
(function () {
  const TYPES = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const STATUS = { pending: ['承認待ち', 'badge-yellow'], approved: ['承認済み', 'badge-green'], rejected: ['却下', 'badge-red'], cancelled: ['取り消し済み', 'badge-gray'] }
  const KIND = { modify: '時刻修正', add: '打刻漏れの追加' }
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const S = window.__attState = window.__attState || { tab: 'timeline', to: null }
  let TL = null
  let busy = false
  const today = () => dayjs().format('YYYY-MM-DD')
  // 'YYYY-MM-DD HH:MM:SS' → 表示（稼働日と違う日は日付も出す）
  const showAt = (at, workDate) => at ? (at.slice(0, 10) === workDate ? at.slice(11, 16) : dayjs(at.slice(0, 10)).format('M/D') + ' ' + at.slice(11, 16)) : ''
  const toInput = (at) => at ? at.slice(0, 16).replace(' ', 'T') : ''
  const statusBadge = (s) => `<span class="badge ${(STATUS[s] || [])[1] || 'badge-gray'}">${(STATUS[s] || [s])[0]}</span>`

  // URL で画面を指定できる（#376 #400 #306）
  //   #attendance                         … 今のタブ（画面を離れると打刻履歴・今日までに戻る。staff.js の route）
  //   #attendance/timeline[/日付[/シフトID]] … 打刻履歴。日付までの2週間を出し、シフトの位置まで送る
  //   #attendance/requests                … 修正申請の一覧
  //   #attendance/request/申請ID           … 修正申請の一覧を出して、その申請の経緯を開く
  let FOCUS_SHIFT = null
  window.renderStaffAttendance = function () {
    const parts = (location.hash || '').slice(1).split('/')
    let openId = null
    FOCUS_SHIFT = null
    if (parts[1] === 'timeline') {
      S.tab = 'timeline'
      S.to = /^\d{4}-\d{2}-\d{2}$/.test(parts[2] || '') ? (parts[2] > today() ? today() : parts[2]) : null
      FOCUS_SHIFT = Number(parts[3]) || null
    } else if (parts[1] === 'requests') S.tab = 'requests'
    else if (parts[1] === 'request' && Number(parts[2])) { S.tab = 'requests'; openId = Number(parts[2]) }
    $app.innerHTML = `
      <a href="#more" class="text-sm text-blue-600 mb-3 inline-block"><i class="fas fa-chevron-left mr-1"></i>その他へ戻る</a>
      <div class="grid grid-cols-2 gap-2 mb-4" role="tablist">
        <button class="btn ${S.tab === 'timeline' ? 'btn-primary' : 'btn-outline'}" role="tab" aria-selected="${S.tab === 'timeline'}" onclick="attTab('timeline')"><i class="fas fa-clock"></i>打刻履歴</button>
        <button class="btn ${S.tab === 'requests' ? 'btn-primary' : 'btn-outline'}" role="tab" aria-selected="${S.tab === 'requests'}" onclick="attTab('requests')"><i class="fas fa-file-pen"></i>修正申請</button>
      </div>
      <div id="att-body"><div class="flex justify-center py-12"><span class="spin"></span></div></div>`
    if (S.tab !== 'requests') return renderTimeline()
    return Promise.resolve(renderRequests()).then(() => { if (openId && window.attDetail) attDetail(openId) })
  }
  // タブを切り替える。URL も合わせて書き換える（再読み込みしても同じタブを開く。履歴は増やさない）
  window.attTab = function (t) {
    S.tab = t === 'requests' ? 'requests' : 'timeline'
    if (S.tab === 'timeline') S.to = null
    try { history.replaceState(null, '', '#attendance/' + S.tab) } catch (e) { }
    renderStaffAttendance()
  }

  // ---------- 打刻履歴（タイムライン） ----------
  async function renderTimeline() {
    const host = document.getElementById('att-body')
    const to = S.to || today()
    try { TL = (await axios.get('/api/staff/attendance/timeline', { params: { to, from: dayjs(to).subtract(13, 'day').format('YYYY-MM-DD') } })).data } catch (e) {
      if (!host.isConnected) return
      host.innerHTML = `<div class="card p-4 text-center" role="alert"><p class="text-sm text-red-600 mb-3">${esc(e && e.response ? errMsg(e, '打刻履歴を読み込めませんでした') : '通信できませんでした。電波の良い場所で再読み込みしてください')}</p>
        <button class="btn btn-outline" data-action="attReload"><i class="fas fa-rotate-right"></i>再読み込み</button></div>`
      return
    }
    if (!host.isConnected) return // 読み込み中にほかの画面へ移った
    const byDate = {}
    for (const s of TL.shifts) (byDate[s.work_date] = byDate[s.work_date] || []).push(s)
    // 期間は『この日まで2週間』を日付で選べる（#376）
    host.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-3">
        <button class="btn btn-outline text-xs" onclick="attMove(-14)" aria-label="前の2週間"><i class="fas fa-chevron-left"></i>前</button>
        <label class="text-xs text-gray-500 text-center">${dayjs(TL.from).format('M/D')}〜
          <input type="date" id="att-to" class="inp py-1 text-xs w-36 inline-block" value="${esc(TL.to)}" max="${esc(today())}" aria-label="この日までの2週間を表示"></label>
        <button class="btn btn-outline text-xs" onclick="attMove(14)" ${TL.to >= today() ? 'disabled' : ''} aria-label="次の2週間">次<i class="fas fa-chevron-right"></i></button>
      </div>
      ${TL.to < today() ? '<p class="text-center mb-2"><button class="text-xs text-blue-600 underline" onclick="attMove(0)">今日までの表示に戻る</button></p>' : ''}
      <p class="text-[11px] text-gray-500 mb-3 px-1">報告をタップすると時刻の修正、未報告の項目は打刻漏れの追加を申請できます。承認されるまで記録は変わりません</p>
      <div class="space-y-3">${Object.keys(byDate).map(d => `
        <section>
          <h3 class="text-sm font-bold text-gray-700 mb-1.5 px-1">${esc(fmtDate(d))}</h3>
          ${byDate[d].map(s => `<div id="att-shift-${Number(s.shift_id)}">${shiftCard(s)}</div>`).join('')}
        </section>`).join('') || '<p class="text-center text-gray-400 py-10">この期間のシフトはありません</p>'}</div>`
    const picker = document.getElementById('att-to')
    if (picker) picker.addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(picker.value)) { S.to = picker.value > today() ? today() : picker.value; renderTimeline() } })
    // シフト一覧から開いたときは、そのシフトの位置まで送って目立たせる
    const focus = FOCUS_SHIFT && document.getElementById('att-shift-' + FOCUS_SHIFT)
    FOCUS_SHIFT = null
    if (focus) {
      focus.scrollIntoView({ block: 'center' })
      const card = focus.firstElementChild
      if (card) { card.classList.add('ring-2', 'ring-blue-400'); setTimeout(() => card.classList.remove('ring-2', 'ring-blue-400'), 2500) }
    }
  }
  // n 日送る（0 で今日までに戻す）。今日より先には送らない
  window.attMove = function (n) { S.to = n ? dayjs(S.to || today()).add(n, 'day').format('YYYY-MM-DD') : null; if (S.to && S.to >= today()) S.to = null; renderTimeline() }
  delegate('attReload', () => renderTimeline())

  function shiftCard(s) {
    const rep = Object.fromEntries(s.reports.map(r => [r.report_type, r]))
    const pend = Object.fromEntries(s.pending.map(p => [p.report_type, p]))
    const absent = s.status === 'absent'
    // 未確定（希望（仮））のシフトは、報告してしまったものだけが返る。打刻の修正・追加は申請できない
    const locked = absent || s.tentative
    const shown = TYPES.filter(t => s.enabled.includes(t) || rep[t] || pend[t])
    const hidden = TYPES.filter(t => !shown.includes(t))
    const row = (t) => {
      const r = rep[t], p = pend[t]
      const action = locked ? '' : p ? `<span class="badge badge-yellow">申請中 ${esc(showAt(p.requested_at, s.work_date))}</span>`
        : `${rejectedTag(s, t)}<button class="btn btn-outline text-xs py-1.5" onclick="attOpen(${s.shift_id}, '${t}')">${rejectedOf(s, t) ? '再申請' : r ? '修正' : '追加申請'}</button>`
      return `<li class="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
        <span class="w-20 text-sm text-gray-700 shrink-0">${LABEL[t]}</span>
        <span class="flex-1 text-sm ${r ? 'font-bold text-gray-900' : 'text-gray-400'}">${r ? esc(showAt(r.reported_at, s.work_date)) : '未報告'}${r && r.entry_method === 'proxy' ? ' <span class="badge badge-purple font-normal">管理者が入力</span>' : ''}${r && (r.corrected_by_correction_id || r.entry_method === 'correction') ? ` <span class="text-[10px] font-normal text-gray-400">（修正済み${r.original_reported_at ? '・元: ' + esc(showAt(r.original_reported_at, s.work_date)) : ''}）</span>` : ''}</span>
        ${action}</li>`
    }
    return `<div class="card p-3 mb-2">
      <div class="flex items-center justify-between gap-2"><p class="font-bold text-gray-800 truncate">${esc(s.project_name)}</p>${absent ? '<span class="badge badge-gray">欠勤</span>' : s.tentative ? '<span class="badge badge-yellow">未確定</span>' : ''}</div>
      <p class="text-xs text-gray-500">${esc(formatShiftTime(s.start_time, s.end_time))}${s.company_name ? ' ・' + esc(s.company_name) : ''}</p>
      ${s.tentative ? '<p class="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 mt-1">管理者の確定待ちのシフトです。確定されるまで打刻の修正・追加は申請できません。勤務した場合は管理者に連絡してください</p>' : ''}
      <ul class="mt-1">${(s.tentative ? shown.filter(t => rep[t]) : shown).map(row).join('')}</ul>
      ${s.reports.some(r => r.entry_method === 'proxy') && !locked ? '<p class="text-[11px] text-gray-500 mt-1">「管理者が入力」は、あなたの代わりに管理者が記録した時刻です。違っていたら「修正」から申請してください</p>' : ''}
      ${!locked && hidden.length ? `<details class="mt-1"><summary class="text-xs text-gray-500 py-1 cursor-pointer">この案件で使っていない報告を追加申請する</summary><ul>${hidden.map(row).join('')}</ul></details>` : ''}
    </div>`
  }

  // ---------- 申請（時刻修正・打刻漏れの追加。同じシフトのほかの報告もまとめて直せる #214） ----------
  const NEXT_DAY = ['break_start', 'break_end', 'work_end', 'check_out']
  const ARRIVAL = ['check_in', 'work_start']
  // 理由の定型文（タップで理由欄に足す。#401）
  const REASONS = ['電波が悪く送れなかった', '押し忘れた', '端末の不具合で送れなかった', '時刻を押し間違えた']
  const SETTLED = '精算が確定済みのシフトです。承認されると勤怠の記録は変わりますが、支払額は自動では変わりません（必要な対応は管理者が行います）'
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const atMin = (workDate, m) => dayjs(workDate).add(m, 'minute')
  const fmtIn = (d) => d.format('YYYY-MM-DDTHH:mm')
  const toAt = (v) => v ? v.replace('T', ' ').slice(0, 16) : ''
  const dj = (at) => dayjs(String(at).slice(0, 16).replace(' ', 'T'))
  function rejectedOf(s, t) { return (s.rejected || []).find(x => x.report_type === t) }
  // 打刻履歴の行の『却下』の印（最新の申請が却下のまま。#399）
  function rejectedTag(s, t) { return rejectedOf(s, t) ? '<span class="badge badge-red">却下</span>' : '' }
  // 予定の開始・終了（稼働日 0:00 からの分。終了が開始以前なら翌日）
  function span(s) { const st = toMin(s.start_time); let en = toMin(s.end_time); if (en <= st) en += 1440; return { st, en } }
  // 入力できる日時の範囲（#312）。サーバー（lib/shift-time.ts の reportableWindow）と同じ終わりと、今の時刻の早いほう。始まりは稼働日の前日 0:00
  function maxFor(s, type) {
    const { en } = span(s)
    const m = NEXT_DAY.includes(type) ? Math.min(Math.max(1439, en + 720), 2879) : ARRIVAL.includes(type) ? Math.max(1439, en) : 1439
    const lim = atMin(s.work_date, m), now = dayjs()
    return lim.isBefore(now) ? lim : now
  }
  const minFor = (s) => fmtIn(dayjs(s.work_date).subtract(1, 'day'))
  // 未報告の既定の時刻（#342）: 予定から推定し、前後の報告の間に収める。起床・出発は開始より前、休憩は予定の休憩を勤務の中ほどに置く
  function defaultFor(s, type) {
    const { st, en } = span(s)
    const brk = s.break_minutes != null ? Number(s.break_minutes) : (en - st >= 360 ? 60 : 0)
    const mid = st + Math.max(0, Math.round((en - st - brk) / 10) * 5)
    const base = { wake_up: st - 120, departure: st - 60, check_in: st - 10, work_start: st, break_start: mid, break_end: mid + brk, work_end: en, check_out: en + 5 }[type]
    let d = atMin(s.work_date, base)
    const rep = Object.fromEntries(s.reports.map(r => [r.report_type, dj(r.reported_at)]))
    const i = TYPES.indexOf(type)
    const prev = TYPES.slice(0, i).reverse().map(t => rep[t]).find(Boolean)
    const next = TYPES.slice(i + 1).map(t => rep[t]).find(Boolean)
    if (prev && next && prev.isBefore(next)) { if (!d.isAfter(prev) || !d.isBefore(next)) d = prev.add(Math.floor(next.diff(prev, 'minute') / 2), 'minute') }
    else if (prev && !d.isAfter(prev)) d = prev.add(1, 'minute')
    else if (next && !d.isBefore(next)) d = next.subtract(1, 'minute')
    const max = maxFor(s, type)
    return fmtIn(d.isAfter(max) ? max : d)
  }
  // 報告の順序の矛盾（サーバーの orderConflicts と同じく分の単位で比べる。同じ分は矛盾にしない）
  function orderIssues(map, type, at, skip) {
    const idx = TYPES.indexOf(type), out = []
    for (const t of TYPES) {
      if (t === type || !map[t] || (skip && skip.has(t))) continue
      const j = TYPES.indexOf(t)
      if (j < idx && map[t] > at) out.push(`${LABEL[type]}が${LABEL[t]}（${showAt(map[t], form.work_date)}）より前です`)
      if (j > idx && map[t] < at) out.push(`${LABEL[type]}が${LABEL[t]}（${showAt(map[t], form.work_date)}）より後です`)
    }
    return out
  }

  let form = null
  window.attOpen = function (shiftId, type) {
    const s = TL && TL.shifts.find(x => x.shift_id === shiftId); if (!s) return
    const r = s.reports.find(x => x.report_type === type)
    const rj = rejectedOf(s, type)
    form = { mode: 'new', shift: s, shift_id: shiftId, report_type: type, kind: r ? 'modify' : 'add', before: r ? r.reported_at : null, work_date: s.work_date, title: s.project_name, rejected: rj || null }
    // 却下された申請があれば、その日時から直せるようにする（新しい申請は再申請としてつながる。#399）
    showForm(rj ? toInput(rj.requested_at) : r ? toInput(r.reported_at) : defaultFor(s, type), '')
  }
  function showForm(value, reason) {
    const s = form.shift
    const rep = Object.fromEntries(s.reports.map(r => [r.report_type, r]))
    const pend = Object.fromEntries((s.pending || []).map(p => [p.report_type, p]))
    const types = TYPES.filter(t => t === form.report_type || (s.enabled || []).includes(t) || rep[t])
    // 同じシフトの報告の一覧（#401）。新規の申請では、ほかの報告も『一緒に直す』でまとめて申請できる（#214）
    const row = (t) => {
      const me = t === form.report_type, r = rep[t], p = pend[t]
      const tail = me ? '<span class="text-[11px] text-blue-700">この報告</span>'
        : p ? `<span class="badge badge-yellow">申請中 ${esc(showAt(p.requested_at, s.work_date))}</span>`
        : form.mode === 'new' ? `<button type="button" class="text-[11px] text-blue-600 underline" data-action="attExtraToggle" data-type="${t}">一緒に直す</button>` : ''
      return `<li class="py-1 ${me ? 'bg-blue-50 rounded px-1 font-bold' : ''}">
        <div class="flex items-center gap-2 text-xs"><span class="w-16 shrink-0 text-gray-600">${LABEL[t]}</span><span class="flex-1 ${r ? 'text-gray-900' : 'text-gray-400'}">${r ? esc(showAt(r.reported_at, s.work_date)) : '未報告'}</span>${tail}</div>
        ${!me && !p && form.mode === 'new' ? `<div class="hidden mt-1" id="att-x-${t}"><input type="datetime-local" class="inp text-sm" data-extra="${t}" min="${minFor(s)}" max="${fmtIn(maxFor(s, t))}"></div>` : ''}</li>`
    }
    const title = form.mode === 'resubmit' ? `再申請（${KIND[form.kind]}）` : `${KIND[form.kind]}の申請`
    modal(`<div id="att-form"><h3 class="font-bold text-gray-800 mb-1">${title}</h3>
      <p class="text-sm text-gray-600">${esc(fmtDate(form.work_date))} ${esc(form.title)} ・<b>${LABEL[form.report_type]}</b></p>
      ${s.settled ? `<p class="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 mt-2"><i class="fas fa-lock mr-1"></i>${esc(SETTLED)}</p>` : ''}
      ${s.request_until ? `<p class="text-[11px] text-gray-500 mt-1">申請の期限: ${esc(fmtDate(s.request_until))}まで</p>` : ''}
      ${form.changed ? `<p class="text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1 mt-2">却下の後に記録が変わりました（今の記録: ${form.before ? esc(showAt(form.before, form.work_date)) : '未報告'}）。今の記録をもとに申請し直します</p>` : ''}
      ${form.rejected ? `<div class="mt-2 p-2 rounded bg-red-50 text-xs text-red-800">前回の申請（${esc(showAt(form.rejected.requested_at, form.work_date))}）は却下されました。<br>理由: ${esc(form.rejected.reject_reason || '')}<br><span class="text-red-500">この申請は再申請として管理者に届きます</span></div>` : ''}
      ${form.before ? `<p class="text-xs text-gray-500 mt-2">今の記録: ${esc(showAt(form.before, form.work_date))}</p>` : '<p class="text-xs text-gray-500 mt-2">未報告の打刻を追加します</p>'}
      <label class="block text-sm text-gray-700 mt-2">${form.kind === 'modify' ? '正しい日時' : '日時'}<input type="datetime-local" id="att-at" class="inp mt-1" value="${esc(value)}" min="${minFor(s)}" max="${fmtIn(maxFor(s, form.report_type))}"></label>
      <div id="att-order" class="mt-1"></div>
      <h4 class="text-xs font-bold text-gray-500 mt-3 mb-0.5">このシフトの報告</h4>
      <ul class="border-t border-b border-gray-100">${types.map(row).join('')}</ul>
      ${form.mode === 'new' ? '<p class="text-[11px] text-gray-500 mt-1">前後の報告も違っている場合は『一緒に直す』で、まとめて申請できます（理由は共通）</p>' : ''}
      <p class="text-sm text-gray-700 mt-3">修正理由（必須）</p>
      <div class="flex flex-wrap gap-1 mt-1">${REASONS.map(t => `<button type="button" class="badge badge-gray" data-action="attReasonPreset" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <textarea id="att-reason" rows="3" maxlength="500" class="inp mt-1" placeholder="例: 店舗の電波が悪く、入店報告を送れなかったため">${esc(reason)}</textarea>
      <div id="att-msg" class="mt-2"></div>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" id="att-submit" data-action="attSubmit">申請する</button></div></div>`)
    form.confirmed = null
    // 日時を変えたら、前に出した警告を消して確認からやり直す（#261）。前後の報告との順序はその場で示す（#401）
    document.getElementById('att-form').addEventListener('input', (e) => { if (e.target && e.target.type === 'datetime-local') { resetConfirm(); showOrder() } })
    showOrder()
  }
  // 入力中の日時（対象と『一緒に直す』の報告）
  function collect() {
    const items = [{ report_type: form.report_type, requested_at: toAt(document.getElementById('att-at').value) }]
    document.querySelectorAll('#att-form [data-extra]').forEach(el => { if (!el.closest('.hidden')) items.push({ report_type: el.dataset.extra, requested_at: toAt(el.value) }) })
    return items
  }
  function showOrder() {
    const box = document.getElementById('att-order'); if (!box) return
    const items = collect().filter(i => i.requested_at)
    const map = Object.fromEntries(form.shift.reports.map(r => [r.report_type, String(r.reported_at).slice(0, 16)]))
    for (const i of items) map[i.report_type] = i.requested_at
    // 一緒に直す報告どうしの矛盾は1回だけ出す
    const done = new Set(), issues = []
    for (const i of items) { issues.push(...orderIssues(map, i.report_type, i.requested_at, done)); done.add(i.report_type) }
    box.innerHTML = issues.length ? `<p class="text-xs text-red-600"><i class="fas fa-triangle-exclamation mr-1"></i>${issues.map(esc).join(' / ')}</p>` : ''
  }
  function resetConfirm() {
    if (!form || !form.confirmed) return
    form.confirmed = null
    document.getElementById('att-msg').innerHTML = ''
    document.getElementById('att-submit').textContent = '申請する'
  }
  delegate('attExtraToggle', (el) => {
    const t = el.dataset.type, box = document.getElementById(`att-x-${t}`); if (!box) return
    const open = box.classList.toggle('hidden') === false
    const input = box.querySelector('input')
    if (open && !input.value) { const r = form.shift.reports.find(x => x.report_type === t); input.value = r ? toInput(r.reported_at) : defaultFor(form.shift, t) }
    el.textContent = open ? '直さない' : '一緒に直す'
    resetConfirm(); showOrder()
  })
  delegate('attReasonPreset', (el) => {
    const ta = document.getElementById('att-reason'); if (!ta) return
    ta.value = ta.value.trim() ? `${ta.value.trim()}。${el.dataset.text}` : el.dataset.text
    ta.focus()
  })
  const warnBox = (ws) => `<div class="p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>報告の順序に矛盾があります</p>
    <ul class="list-disc pl-4 space-y-0.5">${ws.map(w => `<li>${esc(w)}</li>`).join('')}</ul><p class="mt-1">打刻漏れの追加は、このまま申請できます（管理者が確認して承認します）</p></div>`
  const noticeBox = (ns) => `<div class="p-2.5 rounded-lg bg-amber-50 text-xs text-amber-800 mt-1">${ns.map(n => `<p><i class="fas fa-circle-info mr-1"></i>${esc(n)}</p>`).join('')}</div>`
  async function submitForm(btn) {
    const items = collect()
    const reason = document.getElementById('att-reason').value.trim()
    const msg = document.getElementById('att-msg')
    if (items.some(i => !i.requested_at)) { msg.innerHTML = '<p class="text-xs text-red-600">日時を入力してください</p>'; return }
    if (!reason) { msg.innerHTML = '<p class="text-xs text-red-600">修正理由を入力してください</p>'; return }
    const bulk = items.length > 1
    const url = form.mode === 'resubmit' ? `/api/staff/corrections/${form.from_id}/resubmit` : bulk ? '/api/staff/corrections/bulk' : '/api/staff/corrections'
    const body = bulk ? { shift_id: form.shift_id, reason, items } : { shift_id: form.shift_id, report_type: form.report_type, kind: form.kind, requested_at: items[0].requested_at, reason }
    const key = JSON.stringify(items)
    await withSubmitLock(btn, async () => {
      try {
        // 警告を出したときと同じ日時なら、確認済みとして申請する。日時を変えていたら確認からやり直す（#261）
        if (form.confirmed !== key) {
          const { data } = await axios.post(url, { ...body, dry_run: true })
          const ws = data.warnings || [], ns = data.notices || []
          if (ws.length || ns.length) {
            form.confirmed = key
            msg.innerHTML = (ws.length ? warnBox(ws) : '') + (ns.length ? noticeBox(ns) : '')
            btn.textContent = '内容を確認して申請する'
            return
          }
        }
        await axios.post(url, body)
        closeModal(); toast(bulk ? `${items.length}件をまとめて申請しました。承認されると記録が変わります` : '申請しました。承認されると記録が変わります')
        S.tab === 'requests' ? renderRequests() : renderTimeline()
      } catch (e) {
        msg.innerHTML = `<p class="text-xs text-red-600">${esc(errMsg(e))}</p>`
      }
    })
  }
  delegate('attSubmit', (el) => submitForm(el))
  window.attSubmit = function () { const b = document.getElementById('att-submit'); if (b) submitForm(b) }

  // ---------- 自分の申請 ----------
  let LIST = []
  // 通知・メールのリンク（#attendance/request/:id）で開いた申請（#306）
  const requestIdFromHash = () => { const m = (location.hash || '').match(/^#attendance\/request\/(\d+)/); return m ? Number(m[1]) : null }
  // メールのリンクから開いたときは『修正申請』のタブで開く
  if (requestIdFromHash()) S.tab = 'requests'
  async function renderRequests() {
    const host = document.getElementById('att-body')
    try { LIST = (await axios.get('/api/staff/corrections')).data.corrections } catch (e) { host.innerHTML = `<p class="text-red-600 text-sm">${esc(errMsg(e))}</p>`; return }
    host.innerHTML = `<div class="space-y-2">${LIST.map(c => `
      <div class="card p-3" id="att-req-${c.correction_id}">
        <div class="flex items-center justify-between gap-2">${statusBadge(c.status)}<span class="text-[11px] text-gray-400">申請 ${esc(dayjs(c.created_at).format('M/D HH:mm'))}</span></div>
        <p class="font-bold text-gray-800 mt-1.5">${esc(fmtDate(c.work_date))} ${LABEL[c.report_type] || ''} <span class="text-xs font-normal text-gray-500">${KIND[c.kind]}</span></p>
        <p class="text-xs text-gray-500 truncate">${esc(c.project_name || '')}</p>
        ${c.by_admin ? `<p class="text-[11px] text-blue-700 bg-blue-50 rounded px-2 py-1 mt-1"><i class="fas fa-user-tie mr-1"></i>管理者（${esc(c.requested_by_name || '')}）が代わりに申請しました${c.status === 'pending' ? '。取り消しは管理者が行います' : ''}</p>` : ''}
        <p class="text-sm mt-1">${c.before_at ? esc(showAt(c.before_at, c.work_date)) + ' → ' : ''}<b>${esc(showAt(c.requested_at, c.work_date))}</b></p>
        <p class="text-xs text-gray-600 mt-1 whitespace-pre-wrap">理由: ${esc(c.reason)}</p>
        ${c.order_warnings.length ? `<p class="text-[11px] text-amber-700 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>${c.order_warnings.map(esc).join(' / ')}</p>` : ''}
        ${c.status === 'approved' ? `<p class="text-xs text-emerald-700 mt-1.5">承認: ${esc(c.decided_by_name || '')} ${esc(dayjs(c.decided_at).format('M/D HH:mm'))}${c.decision_comment ? '<br>コメント: ' + esc(c.decision_comment) : ''}</p>` : ''}
        ${c.status === 'approved' && c.applied_while_settled ? '<p class="text-[11px] text-amber-800 mt-1">精算が確定済みのシフトのため、支払額は変わっていません（管理者が別途対応します）</p>' : ''}
        ${c.status === 'pending' && c.settled ? '<p class="text-[11px] text-amber-800 mt-1">精算が確定済みのシフトです。承認されても支払額は自動では変わりません</p>' : ''}
        ${c.status === 'rejected' ? `<div class="mt-1.5 p-2 rounded bg-red-50 text-xs text-red-800">却下の理由: ${esc(c.reject_reason || '')}${c.decision_comment ? '<br>コメント: ' + esc(c.decision_comment) : ''}<br><span class="text-red-500">${esc(c.decided_by_name || '')} ${esc(dayjs(c.decided_at).format('M/D HH:mm'))}</span></div>` : ''}
        ${c.status === 'rejected' && c.superseded_by ? `<p class="text-[11px] text-gray-500 mt-1">この報告は、後の申請 #${Number(c.superseded_by)} で申請し直しています</p>` : ''}
        ${c.status === 'cancelled' && c.cancel_reason_label ? `<p class="text-xs text-gray-600 mt-1.5">${esc(c.cancel_reason_label)}、自動で取り消されました。勤怠の記録は変わっていません</p>` : ''}
        ${c.resubmitted_from ? `<p class="text-[11px] text-gray-400 mt-1">再申請（元の申請 #${Number(c.resubmitted_from)}）</p>` : ''}
        <div class="flex gap-2 mt-2">
          <button class="btn btn-outline text-xs flex-1" data-action="attDetail" data-id="${c.correction_id}">経緯を見る</button>
          ${c.status === 'pending' && c.mine ? `<button class="btn btn-danger text-xs flex-1" data-action="attCancel" data-id="${c.correction_id}">取り消す</button>` : ''}
          ${c.status === 'rejected' && c.mine && !c.resubmitted_count && !c.superseded_by ? `<button class="btn btn-primary text-xs flex-1" data-action="attResubmit" data-id="${c.correction_id}">修正して再申請</button>` : ''}
          ${c.by_admin ? '<a href="#consult" class="btn btn-outline text-xs flex-1">管理者に相談する</a>' : ''}
        </div>
      </div>`).join('') || '<p class="text-center text-gray-400 py-10">申請はありません</p>'}</div>`
    const focus = requestIdFromHash()
    if (!focus) return
    const el = document.getElementById(`att-req-${focus}`)
    if (el) { el.classList.add('ring-2', 'ring-blue-400'); el.scrollIntoView({ block: 'center' }) }
    else host.insertAdjacentHTML('afterbegin', '<p class="text-xs text-gray-500 mb-2 px-1">お知らせの申請は一覧にありません（新しい200件まで表示しています）</p>')
  }
  // 申請を開く（通知・メールのリンク #306。staff.js の route が #attendance/request/:id のときに呼ぶ）
  window.attOpenRequest = function (id) {
    S.tab = 'requests'
    const h = `attendance/request/${Number(id)}`
    if (location.hash !== '#' + h) { location.hash = h; return }
    return renderStaffAttendance()
  }
  window.attCancel = async function (id, btn) {
    if (busy || !confirm('この申請を取り消しますか？')) return
    busy = true
    try { await withSubmitLock(btn, () => axios.post(`/api/staff/corrections/${id}/cancel`)); toast('取り消しました') } catch (e) { toast(errMsg(e)) } finally { busy = false; renderRequests() }
  }
  // 再申請（#484）: 申請の種類と『今の記録』は、却下された時点ではなく今の記録から決める（サーバーの resubmitCorrection と同じ判定）
  window.attResubmit = async function (id) {
    const c = LIST.find(x => x.correction_id === id); if (!c) return
    let d; try { d = (await axios.get(`/api/staff/corrections/${id}`)).data } catch (e) { toast(errMsg(e)); return }
    const reports = d.reports || []
    const r = reports.find(x => x.report_type === c.report_type)
    const kind = r ? 'modify' : 'add'
    const changed = kind !== c.kind || (r && c.before_at && String(r.reported_at).slice(0, 16) !== String(c.before_at).slice(0, 16))
    const tl = TL && TL.shifts.find(x => x.shift_id === c.shift_id)
    const shift = { work_date: c.work_date, start_time: c.start_time, end_time: c.end_time, reports, pending: [], enabled: tl ? tl.enabled : [], settled: !!c.settled, break_minutes: tl ? tl.break_minutes : null }
    form = { mode: 'resubmit', from_id: id, shift, shift_id: c.shift_id, report_type: c.report_type, kind, before: r ? r.reported_at : null, work_date: c.work_date, title: c.project_name, changed }
    showForm(toInput(c.requested_at), c.reason)
  }
  delegate('attDetail', (el) => attDetail(Number(el.dataset.id)))
  delegate('attCancel', (el) => attCancel(Number(el.dataset.id), el))
  delegate('attResubmit', (el) => attResubmit(Number(el.dataset.id)))
  const EVENT = { submitted: '申請', resubmitted: '再申請', approved: '承認', approved_exception: '承認（順序の矛盾を確認済み）', rejected: '却下', cancelled: '取り消し' }
  // ---------- 通知（打刻修正申請の受付・承認・却下）----------
  // ホーム・その他を開いたときに未読件数を表示する（staff.js の renderHome / renderMore から呼ぶ）
  window.loadNotifBanner = async function () {
    let n = 0
    try { n = (await axios.get('/api/staff/notifications/unread-count')).data.count } catch (e) { return }
    const banner = document.getElementById('notif-banner')
    if (banner) banner.innerHTML = n ? `<a href="#notifications" class="block bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-800" role="alert"><i class="fas fa-bell mr-1"></i>未読の通知が <b>${n}件</b> あります <span class="underline font-bold ml-1">確認する</span></a>` : ''
    const more = document.getElementById('more-notif-count')
    if (more) { more.textContent = n; more.classList.toggle('hidden', !n) }
  }
  let NOTIF_LIST = []
  window.renderStaffNotifications = async function () {
    loading()
    let d; try { d = (await axios.get('/api/staff/notifications')).data } catch (e) { $app.innerHTML = `<p class="text-red-600 text-sm">${esc(errMsg(e))}</p>`; return }
    NOTIF_LIST = d.notifications
    $app.innerHTML = `
      <div class="flex items-center justify-between mb-3 px-1"><h2 class="font-bold text-gray-800"><i class="fas fa-bell text-blue-600 mr-1"></i>通知</h2>
        ${d.unread ? '<button class="text-xs text-blue-600" onclick="notifReadAllStaff()">すべて既読にする</button>' : ''}</div>
      <div class="space-y-2">${d.notifications.map(n => `
        <button class="card p-3 w-full text-left block ${n.read_at ? '' : 'ring-1 ring-blue-200'}" data-action="notifOpenStaff" data-id="${n.notification_id}">
          <div class="flex items-center gap-2">${n.read_at ? '<span class="badge badge-gray">既読</span>' : '<span class="badge badge-blue">未読</span>'}<span class="text-[11px] text-gray-400 ml-auto">${esc(dayjs(n.created_at.replace(' ', 'T')).format('M/D HH:mm'))}</span></div>
          <p class="font-bold text-gray-800 mt-1 text-sm">${esc(n.title)}</p>
          <p class="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">${esc(n.body || '')}</p>
        </button>`).join('') || '<p class="text-center text-gray-400 py-10">通知はありません</p>'}</div>`
  }
  // 通知の行き先: お知らせの確認のお願い（#191）はそのお知らせ、相談への返信は相談・連絡（#320）、
  // 打刻修正の通知はその申請（#306。リンクの #attendance/request/:id か、古い通知は related_id）
  window.notifOpenStaff = async function (id) {
    try { await axios.post(`/api/staff/notifications/${id}/read`) } catch (e) { }
    const n = NOTIF_LIST.find(x => x.notification_id === id)
    const link = (n && n.link) || ''
    if (/^#notices\/\d+$/.test(link)) { location.hash = link.slice(1); return }
    // 交通費・延長の申請の結果と、管理者の実績の入力（#pay/月。w5-staff-pay-features）
    if (/^#pay(\/\d{4}-\d{2})?$/.test(link)) { location.hash = link.slice(1); return }
    if (n && (n.kind === 'consult_reply' || link === '#consult')) { location.hash = 'consult'; return }
    const m = link.match(/#attendance\/request\/(\d+)$/)
    const reqId = m ? Number(m[1]) : n && /^correction_/.test(n.kind || '') && n.related_id ? Number(n.related_id) : null
    if (reqId) return attOpenRequest(reqId)
    S.tab = 'requests'; location.hash = 'attendance'
  }
  delegate('notifOpenStaff', (el) => notifOpenStaff(Number(el.dataset.id)))
  window.notifReadAllStaff = async function () {
    try { await axios.post('/api/staff/notifications/read-all') } catch (e) { toast(errMsg(e)) }
    renderStaffNotifications()
  }

  window.attDetail = async function (id) {
    let d; try { d = (await axios.get(`/api/staff/corrections/${id}`)).data } catch (e) { toast(errMsg(e)); return }
    const c = d.correction
    modal(`<h3 class="font-bold text-gray-800 mb-1">${LABEL[c.report_type]}（${KIND[c.kind]}）</h3>
      <p class="text-sm text-gray-600 mb-3">${esc(fmtDate(c.work_date))} ${esc(c.project_name || '')} ${statusBadge(c.status)}</p>
      <h4 class="text-xs font-bold text-gray-500 mb-1">この申請の経緯</h4>
      <ol class="space-y-1.5 mb-3">${d.events.map(e => `<li class="text-xs"><span class="text-gray-400">${esc(dayjs(e.created_at).format('M/D HH:mm'))}</span> ${EVENT[e.event] || esc(e.event)} ・${esc(e.actor_name || '')}</li>`).join('')}</ol>
      <h4 class="text-xs font-bold text-gray-500 mb-1">同じ報告の申請</h4>
      <ul class="space-y-1 mb-4">${d.history.map(h => `<li class="text-xs ${h.correction_id === c.correction_id ? 'font-bold' : ''}">#${h.correction_id} ${(STATUS[h.status] || [h.status])[0]} ・${esc(showAt(h.requested_at, c.work_date))}${h.reject_reason ? ' ・却下の理由: ' + esc(h.reject_reason) : ''}</li>`).join('')}</ul>
      <button class="btn btn-outline w-full" onclick="closeModal()">閉じる</button>`)
  }
  // ホームの『報告漏れ』から開く（#483）: 打刻履歴（直近2週間）を出してから、そのシフト・報告の打刻漏れの追加の申請を開く
  window.attOpenMissed = async function (shiftId, type) {
    S.tab = 'timeline'; S.to = null
    if (location.hash !== '#attendance') history.pushState(null, '', '#attendance')
    await (typeof route === 'function' ? route() : renderStaffAttendance())
    if (TL && TL.shifts.some(x => x.shift_id === shiftId)) attOpen(shiftId, type)
  }
})()

// =========================================================
// スタッフ: 勤務時間・支払（#pay・#pay/YYYY-MM。w5-staff-pay-features: #172 #273 #274 #290）
// 月ごとの実働時間（管理者が入力した実績を含む）・勤務日数と、会社が表示を ON にしている場合は支払額（見込み・確定）。
// シフトごとに交通費（実費）と延長（残業）を申請できる。管理者が承認すると、交通費・予定の終了時刻に反映される
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const REQ_STATUS = { pending: ['承認待ち', 'badge-yellow'], approved: ['承認済み', 'badge-green'], rejected: ['却下', 'badge-red'], cancelled: ['取り消し済み', 'badge-gray'] }
  const KIND_LABEL = { transport: '交通費', overtime: '延長' }
  const UNIT_LABEL = { daily: '日給', hourly: '時給' }
  const yenText = (n) => (n == null ? '未設定' : Number(n).toLocaleString('ja-JP') + '円')
  const hrsText = (h) => (h == null ? '-' : (Math.round(h * 100) / 100) + '時間')
  const reqBadge = (s) => `<span class="badge ${(REQ_STATUS[s] || [])[1] || 'badge-gray'}">${esc((REQ_STATUS[s] || [s])[0])}</span>`
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const hhmm = (m) => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }
  const hashMonth = () => (location.hash || '').slice(1).split('/')[1] || ''
  let PAY = null

  window.renderStaffPay = async function () {
    const m = hashMonth()
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : dayjs().format('YYYY-MM')
    loading()
    let data
    try { data = (await axios.get('/api/staff/pay', { params: { month } })).data } catch (e) {
      if ((location.hash || '').slice(1).split('/')[0] !== 'pay') return
      $app.innerHTML = `<div class="card p-4 text-center" role="alert"><p class="text-sm text-red-600 mb-3">${esc(e && e.response ? errMsg(e, '読み込めませんでした') : '通信できませんでした。電波の良い場所で再読み込みしてください')}</p>
        <button class="btn btn-outline" data-action="payReload"><i class="fas fa-rotate-right"></i>再読み込み</button></div>`
      return
    }
    // 読み込み中にほかの画面・ほかの月へ移った
    if ((location.hash || '').slice(1).split('/')[0] !== 'pay' || (hashMonth() || dayjs().format('YYYY-MM')) !== month) return
    PAY = data
    render()
  }
  delegate('payReload', () => renderStaffPay())
  delegate('payMonth', (el) => { location.hash = 'pay/' + el.dataset.month })

  function render() {
    const d = PAY, sm = d.summary, pay = sm.pay
    const prev = dayjs(d.month + '-01').subtract(1, 'month').format('YYYY-MM'), next = dayjs(d.month + '-01').add(1, 'month').format('YYYY-MM')
    $app.innerHTML = `
      <a href="#more" class="text-sm text-blue-600 mb-3 inline-block"><i class="fas fa-chevron-left mr-1"></i>その他へ戻る</a>
      <div class="flex items-center justify-between gap-2 mb-3">
        <button class="btn btn-outline" data-action="payMonth" data-month="${esc(prev)}" aria-label="前の月"><i class="fas fa-chevron-left"></i></button>
        <h2 class="font-bold text-gray-800">${esc(dayjs(d.month + '-01').format('YYYY年M月'))}</h2>
        <button class="btn btn-outline" data-action="payMonth" data-month="${esc(next)}" aria-label="次の月"><i class="fas fa-chevron-right"></i></button>
      </div>
      <section class="card p-4 mb-4" id="pay-summary">
        <div class="grid grid-cols-2 gap-3 text-center">
          <div><p class="text-[11px] text-gray-500">勤務した日数</p><p class="text-xl font-bold text-gray-800">${Number(sm.worked_days)}日</p></div>
          <div><p class="text-[11px] text-gray-500">実働時間の合計</p><p class="text-xl font-bold text-gray-800">${esc(hrsText(sm.worked_hours))}</p></div>
        </div>
        ${sm.scheduled_days ? `<p class="text-xs text-gray-500 text-center mt-2">これからの予定: ${Number(sm.scheduled_days)}日・${esc(hrsText(sm.scheduled_hours))}</p>` : ''}
        ${pay ? `<div class="grid grid-cols-2 gap-3 text-center mt-3 pt-3 border-t border-gray-100">
          <div><p class="text-[11px] text-gray-500">支払の見込み（月の合計）</p><p class="text-lg font-bold text-gray-800">${esc(yenText(pay.estimate_total))}</p></div>
          <div><p class="text-[11px] text-gray-500">うち確定済み</p><p class="text-lg font-bold text-emerald-700">${esc(yenText(pay.confirmed_total))}</p></div>
        </div>
        ${pay.unset ? `<p class="text-[11px] text-amber-700 mt-1 text-center">単価が決まっていないシフトが ${Number(pay.unset)}件 あります（合計に含みません）</p>` : ''}
        <p class="text-[11px] text-gray-400 mt-1">見込みは今の予定・実績での計算です。確定済みは、会社が精算で確定した金額です（税・社会保険などを差し引く前）</p>` : ''}
        <p class="text-[11px] text-gray-400 mt-2">実働は、時給の計算に使う時間です（休憩を除く）。予定の時間の範囲で数える案件では、予定より長く働いた分は「延長を申請」から申請してください</p>
      </section>
      <div class="space-y-2" id="pay-list">${d.shifts.map(shiftCard).join('') || '<p class="text-center text-gray-400 py-10">この月の勤務はありません</p>'}</div>`
  }

  function requestRow(q) {
    const what = q.kind === 'transport'
      ? `${esc(yenText(q.status === 'approved' && q.approved_amount != null ? q.approved_amount : q.amount))}（${q.round_trip ? '往復' : '片道'}・${esc(q.route || '')}）`
      : `終了 ${esc(q.before_end_time || '')} → ${esc(q.status === 'approved' && q.approved_end_time ? q.approved_end_time : q.new_end_time)}`
    const note = q.decision_note && q.status !== 'pending' ? `<span class="block text-gray-500">管理者より: ${esc(q.decision_note)}</span>` : ''
    const cancel = q.status === 'pending' ? `<button class="text-[11px] text-gray-500 underline shrink-0" data-action="payReqCancel" data-id="${Number(q.request_id)}">取り消す</button>` : ''
    return `<li class="flex items-start gap-2 py-1 text-xs"><span class="shrink-0">${reqBadge(q.status)}</span>
      <span class="flex-1 text-gray-700">${esc(KIND_LABEL[q.kind] || q.kind)}: ${what}${note}</span>${cancel}</li>`
  }

  function payBox(s) {
    const p = s.pay
    if (!p) return ''
    const state = s.settled ? '<span class="badge badge-green font-normal">確定</span>' : '<span class="badge badge-gray font-normal">見込み</span>'
    let parts
    if (s.kind === 'cancel') parts = `補償 ${esc(yenText(p.total))}`
    else {
      parts = p.rate != null
        ? `${esc(UNIT_LABEL[p.unit_type] || '')} ${esc(yenText(p.rate))}${p.unit_type === 'hourly' && p.qty != null ? ` × ${esc(p.qty)}時間` : ''} = ${esc(yenText(p.base))}`
        : '単価未設定'
      if (p.transport) parts += ` ＋ 交通費 ${esc(yenText(p.transport))}`
      if (p.adjust) parts += ` ${p.adjust > 0 ? '＋' : '−'} 調整 ${esc(yenText(Math.abs(p.adjust)))}`
    }
    return `<div class="mt-1.5 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700">${parts}
      <span class="block font-bold mt-0.5">合計 ${esc(yenText(p.total))} ${state}</span></div>`
  }

  function shiftCard(s) {
    const cancel = s.kind === 'cancel'
    const src = s.actual_source === 'manual' ? '<span class="badge badge-purple">管理者が入力</span>' : s.actual_source === 'report' ? '<span class="badge badge-gray">報告から</span>' : ''
    let actual
    if (cancel) actual = '<p class="text-xs text-gray-500">欠勤（補償の対象）</p>'
    else if (s.actual_start && s.actual_end) actual = `<p class="text-sm text-gray-800">実働 <b>${esc(formatShiftTime(s.actual_start, s.actual_end))}</b>${s.break_minutes ? `（休憩${Number(s.break_minutes)}分）` : ''}・<b>${esc(hrsText(s.hours))}</b> ${src}</p>`
    else if (s.started) actual = `<p class="text-sm text-gray-500">実績なし（予定の時間で計算: ${esc(hrsText(s.hours))}）</p>`
    else actual = `<p class="text-xs text-gray-400">予定: ${esc(hrsText(s.hours))}</p>`
    const reqs = (s.requests || []).filter(q => q.status !== 'cancelled')
    const canReq = !cancel && s.started && !s.request_block
    const actions = canReq ? `<div class="flex gap-2 mt-2">
        <button class="btn btn-outline flex-1 text-xs" data-action="payReqOpen" data-kind="transport" data-id="${Number(s.shift_id)}"><i class="fas fa-train-subway"></i>交通費を申請</button>
        <button class="btn btn-outline flex-1 text-xs" data-action="payReqOpen" data-kind="overtime" data-id="${Number(s.shift_id)}"><i class="fas fa-clock"></i>延長を申請</button>
      </div>` : !cancel && s.started && s.request_block ? `<p class="text-[11px] text-gray-400 mt-1">${esc(s.request_block)}</p>` : ''
    return `<div class="card p-3" data-shift-id="${Number(s.shift_id)}">
      <div class="flex items-center justify-between gap-2">
        <p class="font-bold text-gray-800 truncate">${esc(fmtDate(s.work_date))} ${esc(s.project_name)}</p>
        ${s.settled ? '<span class="badge badge-green shrink-0">精算確定</span>' : ''}</div>
      <p class="text-xs text-gray-500">予定 ${esc(formatShiftTime(s.start_time, s.end_time))}${!cancel && s.planned_break_minutes ? `（休憩${Number(s.planned_break_minutes)}分）` : ''}${s.company_name ? ' ・' + esc(s.company_name) : ''}</p>
      ${actual}
      ${s.actual_source === 'manual' ? '<p class="text-[11px] text-gray-500">管理者が実績を入力しました。違っている場合は「相談・連絡」から伝えてください</p>' : ''}
      ${payBox(s)}
      ${reqs.length ? `<ul class="mt-1.5 border-t border-gray-100 pt-1">${reqs.map(requestRow).join('')}</ul>` : ''}
      ${actions}
    </div>`
  }

  // ---------- 申請（交通費・延長） ----------
  delegate('payReqOpen', (el) => {
    const s = PAY && PAY.shifts.find(x => x.shift_id === Number(el.dataset.id)); if (!s) return
    const transport = el.dataset.kind === 'transport'
    const head = `<h3 class="font-bold text-gray-800 mb-1">${transport ? '交通費（実費）の申請' : '延長（残業）の申請'}</h3>
      <p class="text-sm text-gray-600 mb-3">${esc(fmtDate(s.work_date))} ${esc(s.project_name)}・予定 ${esc(formatShiftTime(s.start_time, s.end_time))}</p>`
    const foot = `<p id="pay-req-msg" class="hidden text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mt-2" role="alert"></p>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
      <button class="btn btn-primary flex-1" data-action="payReqSubmit" data-kind="${transport ? 'transport' : 'overtime'}" data-id="${Number(s.shift_id)}">申請する</button></div>`
    if (transport) {
      const max = (PAY.limits && PAY.limits.transport_max) || 100000
      modal(`${head}
        <label class="text-sm text-gray-600 block mb-1">区間</label><input id="pay-route" class="inp mb-2" maxlength="100" placeholder="例: 新宿駅〜渋谷駅">
        <label class="text-sm text-gray-600 block mb-1">金額（円）</label><input id="pay-amount" type="number" inputmode="numeric" min="1" max="${Number(max)}" class="inp mb-1">
        <label class="flex items-center gap-2 text-sm text-gray-700 mb-2"><input type="checkbox" id="pay-round" checked>往復（金額は往復の合計で入力）</label>
        <label class="text-sm text-gray-600 block mb-1">メモ（任意）</label><textarea id="pay-reason" class="inp" rows="2" maxlength="500" placeholder="例: 電車が止まりバスで移動"></textarea>
        <p class="text-[11px] text-gray-500 mt-2">${s.transportation_fee ? `今の交通費（実費）は ${esc(yenText(s.transportation_fee))} です。` : ''}承認されると、このシフトの交通費（実費）が申請の金額になります。支払われる額は会社の交通費の決まり（定額・上限など）で決まります</p>
        ${foot}`)
      return
    }
    // 既定の終了: 実績の終了が予定より後ならその時刻、なければ予定の30分後
    const st = toMin(s.start_time); let en = toMin(s.end_time); if (en <= st) en += 1440
    let ae = s.actual_end ? toMin(s.actual_end) : null
    if (ae != null) { while (ae <= st) ae += 1440 }
    const def = hhmm(ae != null && ae > en ? ae : en + 30)
    modal(`${head}
      <label class="text-sm text-gray-600 block mb-1">延長後の終了時刻</label><input id="pay-end" type="time" class="inp mb-2" value="${esc(def)}">
      <label class="text-sm text-gray-600 block mb-1">延長を指示した人（任意）</label><input id="pay-instructed" class="inp mb-2" maxlength="50" placeholder="例: 店長 山田さん">
      <label class="text-sm text-gray-600 block mb-1">理由</label><textarea id="pay-reason" class="inp" rows="2" maxlength="500" placeholder="例: 閉店作業が長引いたため"></textarea>
      <p class="text-[11px] text-gray-500 mt-2">承認されると予定の終了時刻が延び、延びた分も時給の計算に入ります（日給の案件では金額は変わりません。必要な場合は管理者が調整します）</p>
      ${foot}`)
  })
  delegate('payReqSubmit', (el) => withSubmitLock(el, async () => {
    const kind = el.dataset.kind, shiftId = Number(el.dataset.id)
    const val = (id) => { const x = document.getElementById(id); return x ? x.value.trim() : '' }
    const round = document.getElementById('pay-round')
    const body = kind === 'transport'
      ? { shift_id: shiftId, kind, route: val('pay-route'), amount: val('pay-amount'), round_trip: !!(round && round.checked), reason: val('pay-reason') }
      : { shift_id: shiftId, kind, new_end_time: val('pay-end'), instructed_by: val('pay-instructed'), reason: val('pay-reason') }
    const msg = document.getElementById('pay-req-msg')
    try {
      await axios.post('/api/staff/pay/requests', body)
    } catch (e) {
      if (msg) { msg.textContent = errMsg(e, '申請できませんでした'); msg.classList.remove('hidden') } else toast(errMsg(e))
      return
    }
    closeModal(); toast('申請しました。管理者の承認を待ってください')
    renderStaffPay()
  }))
  delegate('payReqCancel', (el) => withSubmitLock(el, async () => {
    if (!window.confirm('この申請を取り消しますか？')) return
    try { await axios.post(`/api/staff/pay/requests/${Number(el.dataset.id)}/cancel`) } catch (e) { toast(errMsg(e)); return }
    toast('申請を取り消しました')
    renderStaffPay()
  }))

  // 「その他」メニューに項目を足し、画面を登録する（staff.js の routes・titles・MORE_SUB_TABS）
  const origMore = window.renderMore
  if (origMore) {
    window.renderMore = function () {
      if (origMore() === false) return false // URL を #more に変えて描き直す途中
      const html = `<a href="#pay" class="report-btn">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-yen-sign"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">勤務時間・支払</span><span class="block text-xs text-gray-400">月の勤務日数・実働時間の確認、交通費・延長の申請</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </a>`
      const at = $app.querySelector('a[href="#attendance"]')
      if (at) at.insertAdjacentHTML('afterend', html)
      else { const wrap = $app.querySelector('.space-y-3'); if (wrap) wrap.insertAdjacentHTML('beforeend', html) }
    }
  }
  if (typeof routes === 'object') { routes.pay = () => window.renderStaffPay(); if (origMore) routes.more = window.renderMore }
  if (typeof titles === 'object') titles.pay = '勤務時間・支払'
  if (typeof MORE_SUB_TABS !== 'undefined' && !MORE_SUB_TABS.includes('pay')) MORE_SUB_TABS.push('pay')
})()
