// =========================================================
// 管理画面: 通知（受信箱）とメール送信状況（送信失敗の確認・再送・メールの記録・問い合わせ先の設定）
// docs/spec_attendance_correction.md 5章。admin.js・corrections.js の後に読み込む（#notifications / #corrections/emails）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const EVENT = { submitted: '申請', resubmitted: '再申請', approved: '承認', rejected: '却下', cancelled: '取り消し' }
  const KIND = { correction_submitted: '承認依頼', correction_received: '受付', correction_approved: '承認の結果', correction_rejected: '却下の結果', correction_processed: '処理の控え', correction_changed_by_admin: '管理者による修正', correction_cancelled: '自動の取り消し', incident_reported: 'インシデント・クレーム',
    recruit_applied: '新しい応募', board_message: '案件掲示板', roster_chat: '企業間チャット', consult_received: '相談・連絡', consult_message: '相談への追加の連絡',
    roster_source_retired: '所属元での退職', roster_host_note: '連携先からの追記' }
  // 送信の失敗・停止の理由。送信サービスの理由は「コード: 内容」の形で、コロンの後をそのまま添える（#438）
  const ERR = {
    mail_not_configured: 'メールの送信設定がありません（RESEND_API_KEY / MAIL_FROM）', resend_error: 'メール送信サービスがエラーを返しました', network_error: '通信エラー',
    source_missing: '申請または宛先のユーザーが見つかりません', recipient_suspended: '宛先のアカウントが停止中のため送信しません', already_processed: '申請が処理済み・取り消し済みのため承認依頼は送りません',
    no_address: '宛先のユーザーにメールアドレスが登録されていません', invalid_address: 'メールアドレスの形式が正しくありません', internal_error: '送信処理が途中で止まりました',
    bounced: '宛先に届きませんでした（アドレスの誤り・使われていないアドレス）。アドレスを直してから再送してください', bounced_soft: '一時的に届きませんでした（受信側の容量・混雑など）',
    complained: '受信者が迷惑メールとして報告しました', suppressed_bounced: '以前に届かなかったアドレスのため送っていません。アドレスを直すか、送信の停止を解除してください',
    suppressed_complained: '迷惑メールと報告されたアドレスのため送っていません', company_inactive: 'ご契約が停止中のため送っていません',
  }
  const errText = (e) => { if (!e) return ''; const k = String(e).split(':')[0]; const rest = String(e).slice(k.length + 1).trim(); return (ERR[k] || k) + (rest ? `（${rest}）` : '') }
  const fmtAt = (at) => at ? dayjs(at.replace(' ', 'T')).format('YYYY/M/D HH:mm') : '－'

  window.refreshNotifBadge = async function () {
    try {
      const { data } = await axios.get('/api/admin/notifications/unread-count')
      if (window.setNavCount) setNavCount('notifications', data.count)
      const el = document.getElementById('notif-badge'); if (!el) return
      el.textContent = data.count; el.classList.toggle('hidden', !data.count)
    } catch (e) { }
    // 打刻修正と応募の件数も同じ間隔で更新する（#423）
    if (window.refreshCorrectionsBadge) refreshCorrectionsBadge()
    if (window.refreshRecruitBadge) refreshRecruitBadge()
  }
  // バッジの定期更新は、ログインの期限切れ・アカウントの切り替えの後は止める（admin.js の sessionUsable。#526）
  const pollable = () => !window.sessionUsable || window.sessionUsable()
  setTimeout(() => { if (pollable()) window.refreshNotifBadge() }, 1000)
  setInterval(() => { if (!document.hidden && pollable()) window.refreshNotifBadge() }, 60000)

  // ---------- 通知（受信箱）----------
  // 未読だけ・種類で絞り込み、50件ずつ「さらに読み込む」で続きを出す（#380）
  const INBOX_PAGE = 50
  const INBOX = { unread: false, kind: '', rows: [], hasMore: false, unread_total: 0, unread_by_kind: {} }
  const inboxQuery = (before) => ({ limit: INBOX_PAGE, ...(INBOX.unread ? { unread: 1 } : {}), ...(INBOX.kind ? { kind: INBOX.kind } : {}), ...(before ? { before } : {}) })
  async function loadInbox(more) {
    const last = more && INBOX.rows.length ? INBOX.rows[INBOX.rows.length - 1].notification_id : null
    const d = (await axios.get('/api/admin/notifications', { params: inboxQuery(last) })).data
    INBOX.rows = more ? INBOX.rows.concat(d.notifications) : d.notifications
    INBOX.hasMore = !!d.has_more
    INBOX.unread_total = d.unread || 0
    INBOX.unread_by_kind = d.unread_by_kind || {}
  }
  const inboxItem = (n) => `
        <button class="card p-3 w-full text-left block ${n.read_at ? '' : 'ring-1 ring-blue-200'}" data-action="notifOpen" data-id="${n.notification_id}" data-link="${esc(n.link || '')}">
          <div class="flex items-center gap-2">${n.read_at ? '' : '<span class="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>'}<span class="badge badge-gray text-[10px]">${esc(KIND[n.kind] || n.kind || '')}</span>${processedBadge(n)}
            <span class="text-[11px] text-gray-400 ml-auto">${esc(fmtAt(n.created_at))}</span></div>
          <p class="font-bold text-gray-800 mt-1 text-sm">${esc(n.title)}</p>
          <p class="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">${esc(n.body || '')}</p>
        </button>`
  function drawInbox() {
    const kinds = Object.keys(KIND)
    const shown = INBOX.rows.length
    const filtered = INBOX.unread || INBOX.kind
    const unreadInView = INBOX.kind ? (INBOX.unread_by_kind[INBOX.kind] || 0) : INBOX.unread_total
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 class="text-xl font-bold text-gray-800"><i class="fas fa-bell text-blue-600 mr-1"></i>通知 ${INBOX.unread_total ? `<span class="badge badge-red">${INBOX.unread_total}件 未読</span>` : ''}</h2>
        ${INBOX.unread_total ? '<button class="btn btn-outline text-sm" data-action="notifReadAll">すべて既読にする</button>' : ''}
      </div>
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <label class="flex items-center gap-1 text-sm text-gray-600"><input type="checkbox" id="inbox-unread" ${INBOX.unread ? 'checked' : ''}>未読のみ</label>
        <select id="inbox-kind" class="text-sm border border-gray-200 rounded-lg px-2 py-1.5" aria-label="種類">
          <option value="">すべての種類</option>
          ${kinds.map(k => `<option value="${k}" ${INBOX.kind === k ? 'selected' : ''}>${esc(KIND[k])}${INBOX.unread_by_kind[k] ? `（未読${INBOX.unread_by_kind[k]}）` : ''}</option>`).join('')}
        </select>
        ${filtered ? '<button class="text-xs text-blue-600 hover:underline" data-action="inboxClear">絞り込みを解除</button>' : ''}
      </div>
      ${!INBOX.unread && unreadInView > INBOX.rows.filter(n => !n.read_at).length && INBOX.hasMore
        ? `<p class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-3">表示している${shown}件より古い未読があります。「未読のみ」にすると、未読だけをまとめて見られます。</p>` : ''}
      <div class="space-y-2">${INBOX.rows.map(inboxItem).join('') || `<p class="text-center text-gray-400 py-10">${filtered ? '条件に合う通知はありません' : '通知はありません'}</p>`}</div>
      ${INBOX.hasMore ? '<div class="text-center mt-3"><button class="btn btn-outline text-sm" data-action="inboxMore">さらに読み込む</button></div>' : ''}`
    document.getElementById('inbox-unread').addEventListener('change', e => { INBOX.unread = e.target.checked; renderNotificationsInbox() })
    document.getElementById('inbox-kind').addEventListener('change', e => { INBOX.kind = e.target.value; renderNotificationsInbox() })
  }
  window.renderNotificationsInbox = async function () {
    loading()
    try { await loadInbox(false) } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    drawInbox()
    window.refreshNotifBadge()
  }
  delegate('inboxMore', el => withSubmitLock(el, async () => {
    try { await loadInbox(true) } catch (e) { showApiError(e, '通知を読み込めませんでした'); return }
    drawInbox()
  }))
  delegate('inboxClear', () => { INBOX.unread = false; INBOX.kind = ''; renderNotificationsInbox() })
  // 承認依頼のうち、ほかの管理者が処理した・取り消された申請（#189）
  const DONE = { approved: '承認', rejected: '却下', cancelled: '取り消し' }
  const processedBadge = (n) => n.kind === 'correction_submitted' && n.correction_status && n.correction_status !== 'pending'
    ? `<span class="badge badge-green text-[10px]">処理済み（${DONE[n.correction_status] || esc(n.correction_status)}${n.correction_decided_by && n.correction_status !== 'cancelled' ? ': ' + esc(n.correction_decided_by) : ''}）</span>` : ''
  delegate('notifOpen', el => window.notifOpen(Number(el.dataset.id), el.dataset.link || ''))
  window.notifOpen = async function (id, link) {
    try { await axios.post(`/api/admin/notifications/${id}/read`) } catch (e) { }
    window.refreshNotifBadge()
    const hash = (link.split('#')[1] || '')
    if (hash) location.hash = hash; else renderNotificationsInbox()
  }
  delegate('notifReadAll', el => withSubmitLock(el, async () => {
    try { await axios.post('/api/admin/notifications/read-all') } catch (e) { toast(errMsg(e)) }
    renderNotificationsInbox()
  }))

  // ---------- メール送信状況 ----------
  // 打刻修正の通知: 送信失敗・止まった送信中の再送（1件ずつ・まとめて #444 #311）、対応不要（#357）、ページ送り
  // メールの記録: お知らせ・パスワード再設定なども含めた送信の記録（#438）。届かなかったメール（不達・迷惑メールの報告 #541）
  // 設定: お知らせメールの問い合わせ先（#367）と、送信を止めているアドレス（#541）
  const MAIL = { view: 'corrections', status: 'failed', logStatus: '', logType: '' }
  const VIEWS = [['corrections', '打刻修正の通知'], ['logs', 'メールの記録'], ['settings', '問い合わせ先・送信停止']]
  const TYPE_LABEL = { notice: 'お知らせ', attendance_correction: '打刻修正の通知', incident_report: 'インシデントの通知', password_reset: 'パスワード再設定', account_email: 'メールアドレスの確認',
    recruit_applied: '新しい応募の通知', board_message: '案件掲示板の通知', roster_chat: '企業間チャットの通知', consultation: '相談・連絡の通知' }
  const LOG_STATUS = { sent: ['送信済み', 'badge-green'], delivered: ['配信済み', 'badge-green'], failed: ['送信失敗', 'badge-red'], bounced: ['不達', 'badge-red'], bounced_soft: ['一時的な不達', 'badge-yellow'], complained: ['迷惑メール報告', 'badge-red'], skipped: ['送信無効の環境', 'badge-gray'] }
  let ROWS = [], HAS_MORE = false

  function mailHeader() {
    return `
      <a href="#corrections" class="text-sm text-blue-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>打刻修正承認</a>
      <h2 class="text-xl font-bold text-gray-800 mt-2"><i class="fas fa-envelope text-blue-600 mr-1"></i>メール送信状況</h2>
      <div class="flex gap-1 mt-2 mb-3 overflow-x-auto">${VIEWS.map(([k, l]) => `<button class="btn ${MAIL.view === k ? 'btn-primary' : 'btn-outline'} text-xs whitespace-nowrap" data-action="mailView" data-view="${k}">${l}</button>`).join('')}</div>`
  }
  delegate('mailView', el => { MAIL.view = el.dataset.view; renderCorrectionEmails() })

  window.renderCorrectionEmails = async function () {
    loading()
    if (MAIL.view === 'logs') return renderMailLogs()
    if (MAIL.view === 'settings') return renderMailSettings()
    return renderDeliveries()
  }

  // ---- 打刻修正の通知 ----
  const st = (r) => r.status === 'sent' ? '<span class="badge badge-green whitespace-nowrap">送信済み</span>'
    : r.status === 'failed' ? '<span class="badge badge-red whitespace-nowrap">送信失敗</span>'
    : r.status === 'skipped' ? '<span class="badge badge-gray whitespace-nowrap">対応不要</span>'
    : r.stalled ? '<span class="badge badge-red whitespace-nowrap">送信中のまま停止</span>' : '<span class="badge badge-yellow whitespace-nowrap">送信中</span>'
  const resendable = (r) => r.status === 'failed' || (r.status === 'pending' && r.stalled)
  const actionBtn = (r, cls) => resendable(r) ? `<button class="btn btn-outline text-xs ${cls}" data-action="mailResend" data-id="${r.delivery_id}"><i class="fas fa-rotate"></i>再送</button>` : ''
  const deliveryParams = (before) => ({ status: MAIL.status, ...(before ? { before } : {}) })
  async function loadDeliveries(more) {
    const last = more && ROWS.length ? ROWS[ROWS.length - 1].delivery_id : null
    const d = (await axios.get('/api/admin/notification-emails', { params: deliveryParams(last) })).data
    ROWS = more ? ROWS.concat(d.deliveries) : d.deliveries
    HAS_MORE = !!d.has_more
    return d
  }
  async function renderDeliveries(more) {
    let d; try { d = await loadDeliveries(more) } catch (e) { $app.innerHTML = mailHeader() + `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const n = d.counts || {}
    const tab = (k, l) => `<button class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${MAIL.status === k ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}" data-action="mailTab" data-status="${k}">${l}${n[k] ? ` <span class="text-xs opacity-80">${n[k]}</span>` : ''}</button>`
    const rows = ROWS
    const rowHtml = (r) => `<tr><td>${st(r)}</td><td class="text-xs whitespace-nowrap">${EVENT[r.event] || esc(r.event)}・${KIND[r.kind] || ''}</td>
          <td class="text-xs">${esc(r.recipient_name || '')}<br><span class="text-gray-400">${esc(r.to_email || '')}</span></td>
          <td class="text-xs"><a class="text-blue-600 hover:underline" href="#corrections/${r.correction_id}">#${r.correction_id}</a> ${esc(r.staff_name || '')} ${r.work_date ? dayjs(r.work_date).format('M/D') : ''} ${LABEL[r.report_type] || ''}</td>
          <td class="text-xs ${r.status === 'skipped' ? 'text-gray-500' : 'text-red-600'}">${esc(errText(r.error))}</td><td class="text-xs">${r.attempts}回</td>
          <td class="text-xs whitespace-nowrap">${esc(fmtAt(r.last_attempt_at))}${r.last_attempt_by_name ? '<br><span class="text-gray-400">再送: ' + esc(r.last_attempt_by_name) + '</span>' : ''}</td><td>${actionBtn(r, 'whitespace-nowrap')}</td></tr>`
    const cardHtml = (r) => `<div class="card p-3">
        <div class="flex items-center justify-between gap-2">${st(r)}<span class="text-[11px] text-gray-400">${r.attempts}回 ・${esc(fmtAt(r.last_attempt_at))}</span></div>
        <p class="text-sm font-bold mt-1">${esc(r.recipient_name || '')} <span class="text-xs font-normal text-gray-500">${EVENT[r.event] || ''}・${KIND[r.kind] || ''}</span></p>
        <p class="text-xs text-gray-500 break-all">${esc(r.to_email || '')}</p>
        <p class="text-xs mt-1"><a class="text-blue-600" href="#corrections/${r.correction_id}">#${r.correction_id}</a> ${esc(r.staff_name || '')} ${LABEL[r.report_type] || ''}</p>
        ${r.error ? `<p class="text-xs ${r.status === 'skipped' ? 'text-gray-500' : 'text-red-600'} mt-1">${esc(errText(r.error))}</p>` : ''}
        ${resendable(r) ? `<div class="mt-2">${actionBtn(r, 'w-full')}</div>` : ''}</div>`
    $app.innerHTML = mailHeader() + `
      <div class="flex items-center justify-between flex-wrap gap-2">
        <p class="text-xs text-gray-500">打刻修正申請の通知メールの送信結果です。送信に失敗しても申請・承認は保存されています。失敗したメールは再送できます（再送の結果も記録します）。宛先は送るときのアドレスです（アドレスを直した後に再送すると、直したアドレスへ送ります）</p>
        <div class="flex gap-2">
          ${n.resendable ? `<button class="btn btn-primary text-sm" data-action="mailResendAll" data-count="${Number(n.resendable)}"><i class="fas fa-rotate"></i>送信失敗をまとめて再送（${Number(n.resendable)}件）</button>` : ''}
          <a class="btn btn-outline text-sm" href="/api/admin/notification-emails/export${['all', 'stalled'].includes(MAIL.status) ? '' : '?status=' + MAIL.status}"><i class="fas fa-file-csv"></i>CSV 出力</a>
        </div>
      </div>
      <div id="mail-bulk-result"></div>
      <div class="flex gap-2 overflow-x-auto pb-1 my-3">${tab('failed', '送信失敗')}${tab('stalled', '止まった送信')}${tab('pending', '送信中')}${tab('sent', '送信済み')}${tab('skipped', '対応不要')}${tab('all', 'すべて')}</div>
      ${MAIL.status === 'stalled' || (MAIL.status === 'pending' && n.stalled) ? `<p class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-3">送信中のまま${Number(d.stalled_minutes) || 10}分以上たったメールは、送信の処理が途中で止まったとみなし、再送できます。</p>` : ''}
      ${MAIL.status === 'skipped' ? '<p class="text-xs text-gray-500 mb-3">処理済み・取り消し済みの申請の承認依頼と、停止中の宛先あてのメールです。送る必要がないため再送しません。</p>' : ''}
      <div class="hidden md:block card overflow-x-auto"><table class="tbl">
        <thead><tr><th>状態</th><th>通知</th><th>宛先</th><th>申請</th><th>理由</th><th>試行</th><th>最終送信</th><th></th></tr></thead>
        <tbody>${rows.map(rowHtml).join('') || '<tr><td colspan="8" class="text-center text-gray-400 py-6">該当するメールはありません</td></tr>'}</tbody></table></div>
      <div class="md:hidden space-y-2">${rows.map(cardHtml).join('') || '<p class="text-center text-gray-400 py-6">該当するメールはありません</p>'}</div>
      ${HAS_MORE ? '<div class="text-center mt-3"><button class="btn btn-outline text-sm" data-action="mailMore">さらに読み込む</button></div>' : ''}`
  }
  delegate('mailTab', el => { MAIL.status = el.dataset.status; renderCorrectionEmails() })
  window.mailTab = function (k) { MAIL.status = k; renderCorrectionEmails() }
  delegate('mailMore', el => withSubmitLock(el, () => renderDeliveries(true)))
  delegate('mailResend', el => withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post(`/api/admin/notification-emails/${Number(el.dataset.id)}/resend`)
      toast(data.sent ? '再送しました' : `再送に失敗しました（${errText(data.error)}）`)
    } catch (e) { toast(errMsg(e)) }
    // 一覧を読み直し、画面のスクロール位置は保つ（先頭に戻さない）
    const y = window.scrollY
    await renderDeliveries()
    window.scrollTo(0, y)
  }))
  // まとめて再送: 古い順に少しずつ送り、終わるまで続ける。結果（成功・失敗・対応不要）を画面に出す
  delegate('mailResendAll', el => withSubmitLock(el, async () => {
    if (!confirm(`送信失敗（送信中のまま止まったものを含む）${Number(el.dataset.count)}件をまとめて再送します。よろしいですか？\n処理済みの申請の承認依頼と、停止中の宛先あてのものは「対応不要」にして送りません。`)) return
    const total = { sent: 0, failed: 0, skipped: 0, reasons: {} }
    let after = 0, guard = 0
    const box = document.getElementById('mail-bulk-result')
    try {
      for (;;) {
        const { data } = await axios.post('/api/admin/notification-emails/resend-failed', { after })
        total.sent += data.sent; total.failed += data.failed; total.skipped += data.skipped
        for (const [k, v] of Object.entries(data.reasons || {})) total.reasons[k] = (total.reasons[k] || 0) + v
        if (box) box.innerHTML = `<p class="text-xs text-gray-600 mt-2"><span class="spin mr-1"></span>再送しています… 成功 ${total.sent}件・失敗 ${total.failed}件（残り ${Number(data.remaining)}件）</p>`
        if (data.done || data.next_after === after || ++guard > 200) break
        after = data.next_after
      }
    } catch (e) { toast(errMsg(e, '再送を最後まで行えませんでした')) }
    await renderDeliveries()
    const box2 = document.getElementById('mail-bulk-result')
    const reasons = Object.entries(total.reasons).map(([k, v]) => `${esc(errText(k))} ${v}件`).join(' ／ ')
    if (box2) box2.innerHTML = `<div class="card p-3 mt-2 text-sm ${total.failed ? 'border-red-200' : ''}">まとめて再送しました: 成功 <b>${total.sent}</b>件・失敗 <b class="${total.failed ? 'text-red-600' : ''}">${total.failed}</b>件・対応不要 ${total.skipped}件
      ${reasons ? `<p class="text-xs text-red-600 mt-1">失敗の理由: ${reasons}</p>` : ''}</div>`
  }))

  // ---- メールの記録（email_logs）----
  async function renderMailLogs(more) {
    const last = more && ROWS.length ? ROWS[ROWS.length - 1].log_id : null
    let d
    try {
      d = (await axios.get('/api/admin/email-logs', { params: { ...(MAIL.logStatus ? { status: MAIL.logStatus } : {}), ...(MAIL.logType ? { type: MAIL.logType } : {}), ...(last ? { before: last } : {}) } })).data
    } catch (e) { $app.innerHTML = mailHeader() + `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    ROWS = more ? ROWS.concat(d.logs) : d.logs
    HAS_MORE = !!d.has_more
    const badge = (s) => { const [l, c] = LOG_STATUS[s] || [s, 'badge-gray']; return `<span class="badge ${c} whitespace-nowrap">${esc(l)}</span>` }
    $app.innerHTML = mailHeader() + `
      <p class="text-xs text-gray-500 mb-3">お知らせ・打刻修正の通知・パスワード再設定などのメールの送信記録です。「配信済み」「不達」「迷惑メール報告」は、送信サービスから届いた結果です。ほかの会社に登録されたアドレス（連携スタッフの所属元）は伏せています</p>
      <div class="flex flex-wrap gap-2 mb-3">
        <select id="ml-status" class="text-sm border border-gray-200 rounded-lg px-2 py-1.5" aria-label="状態">
          ${[['', 'すべての状態'], ['failed', '届かなかったもの（失敗・不達・迷惑メール報告）'], ['sent', '送信済み'], ['delivered', '配信済み']].map(([v, l]) => `<option value="${v}" ${MAIL.logStatus === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <select id="ml-type" class="text-sm border border-gray-200 rounded-lg px-2 py-1.5" aria-label="種類">
          <option value="">すべての種類</option>${(d.types || []).map(t => `<option value="${esc(t)}" ${MAIL.logType === t ? 'selected' : ''}>${esc(TYPE_LABEL[t] || t)}</option>`).join('')}
        </select>
      </div>
      <div class="space-y-2">${ROWS.map(r => `<div class="card p-3">
        <div class="flex items-center gap-2 flex-wrap">${badge(r.status)}<span class="badge badge-gray text-[10px]">${esc(TYPE_LABEL[r.type] || r.type)}</span>
          ${r.suppressed ? '<span class="badge badge-red text-[10px]">送信停止中のアドレス</span>' : ''}<span class="text-[11px] text-gray-400 ml-auto">${esc(fmtAt(r.created_at))}</span></div>
        <p class="text-sm mt-1">${esc(r.recipient_name || '')} <span class="text-xs text-gray-500 break-all">${esc(r.to_email || '')}</span></p>
        ${r.error ? `<p class="text-xs text-red-600 mt-1">${esc(errText(r.error))}</p>` : ''}</div>`).join('') || '<p class="text-center text-gray-400 py-6">該当するメールはありません</p>'}</div>
      ${HAS_MORE ? '<div class="text-center mt-3"><button class="btn btn-outline text-sm" data-action="mailLogsMore">さらに読み込む</button></div>' : ''}`
    document.getElementById('ml-status').addEventListener('change', e => { MAIL.logStatus = e.target.value; renderCorrectionEmails() })
    document.getElementById('ml-type').addEventListener('change', e => { MAIL.logType = e.target.value; renderCorrectionEmails() })
  }
  delegate('mailLogsMore', el => withSubmitLock(el, () => renderMailLogs(true)))

  // ---- 問い合わせ先・送信停止 ----
  const SUP_REASON = { bounced: '届かなかった（不達）', complained: '迷惑メールと報告された' }
  async function renderMailSettings() {
    let m, s
    try { [m, s] = await Promise.all([axios.get('/api/admin/settings/mail-contact'), axios.get('/api/admin/email-suppressions')]).then(r => r.map(x => x.data)) }
    catch (e) { $app.innerHTML = mailHeader() + `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const ro = m.can_edit ? '' : 'disabled'
    $app.innerHTML = mailHeader() + `
      <section class="card p-4 mb-4">
        <h3 class="font-bold text-gray-800 mb-1">お知らせメールの問い合わせ先</h3>
        <p class="text-xs text-gray-500 mb-3">お知らせメールの件名に会社名（${esc(m.company_name)}）を入れ、本文の末尾に問い合わせ先を書きます。返信先のアドレスを設定すると、スタッフがメールに返信したときにそのアドレスへ届きます。</p>
        <div class="grid md:grid-cols-2 gap-3">
          <div><label class="text-xs text-gray-600 block mb-1">返信先・問い合わせのメールアドレス</label><input id="mc-reply" type="email" class="inp" value="${esc(m.reply_to || '')}" placeholder="例: staff-support@example.co.jp" ${ro}></div>
          <div><label class="text-xs text-gray-600 block mb-1">問い合わせの電話番号</label><input id="mc-phone" type="tel" class="inp" value="${esc(m.phone || '')}" placeholder="例: 03-1234-5678" ${ro}></div>
        </div>
        ${m.can_edit ? '<div class="flex justify-end mt-3"><button class="btn btn-primary text-sm" data-action="mailContactSave">保存</button></div>' : '<p class="text-xs text-gray-400 mt-2">変更できるのは会社管理者です。</p>'}
      </section>
      <section class="card p-4">
        <h3 class="font-bold text-gray-800 mb-1">送信を止めているアドレス</h3>
        <p class="text-xs text-gray-500 mb-3">宛先に届かなかった（アドレスの誤り・使われていないアドレス）か、迷惑メールと報告されたアドレスには、メールを送っていません。送り続けると、ほかのメールも届きにくくなるためです。スタッフ詳細などでアドレスを正しいものに直すと、直したアドレスへ送ります。受信できるようになったと本人に確かめた場合は、停止を解除できます。</p>
        <div class="space-y-2">${(s.suppressions || []).map(x => `<div class="flex items-center gap-2 flex-wrap border-b border-gray-100 pb-2">
          <span class="text-sm">${esc(x.names || '')}</span><span class="text-xs text-gray-500 break-all">${esc(x.email)}</span>
          <span class="badge badge-red text-[10px]">${esc(SUP_REASON[x.reason] || x.reason)}</span><span class="text-[11px] text-gray-400">${esc(fmtAt(x.created_at))}</span>
          ${s.can_release ? `<button class="btn btn-outline text-xs ml-auto" data-action="mailSupRelease" data-email="${esc(x.email)}">停止を解除</button>` : ''}
          ${x.detail ? `<p class="w-full text-[11px] text-gray-400">${esc(x.detail)}</p>` : ''}</div>`).join('') || '<p class="text-sm text-gray-400">ありません</p>'}</div>
      </section>`
  }
  delegate('mailContactSave', el => withSubmitLock(el, async () => {
    try {
      await axios.put('/api/admin/settings/mail-contact', { reply_to: document.getElementById('mc-reply').value.trim(), phone: document.getElementById('mc-phone').value.trim() })
      toast('保存しました')
    } catch (e) { showApiError(e, '保存に失敗しました') }
  }))
  delegate('mailSupRelease', el => withSubmitLock(el, async () => {
    if (!confirm(`${el.dataset.email} への送信の停止を解除します。受信できることを本人に確かめましたか？`)) return
    try { await axios.post('/api/admin/email-suppressions/release', { email: el.dataset.email }); toast('解除しました') } catch (e) { showApiError(e, '解除できませんでした'); return }
    renderCorrectionEmails()
  }))
})()
