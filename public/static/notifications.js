// =========================================================
// 管理画面: 通知（受信箱）とメール送信状況（送信失敗の確認・再送）
// docs/spec_attendance_correction.md 5章。admin.js・corrections.js の後に読み込む（#notifications / #corrections/emails）
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const EVENT = { submitted: '申請', resubmitted: '再申請', approved: '承認', rejected: '却下', cancelled: '取り消し' }
  const KIND = { correction_submitted: '承認依頼', correction_received: '受付', correction_approved: '承認の結果', correction_rejected: '却下の結果', correction_processed: '処理の控え', correction_changed_by_admin: '管理者による修正', correction_cancelled: '自動の取り消し' }
  const ERR = { mail_not_configured: 'メールの送信設定がありません（RESEND_API_KEY / MAIL_FROM）', resend_error: 'メール送信サービスがエラーを返しました', network_error: '通信エラー', source_missing: '申請または宛先のユーザーが見つかりません', recipient_suspended: '宛先のアカウントが停止中のため送信しません', already_processed: '申請が処理済み・取り消し済みのため承認依頼は送りません' }
  const fmtAt = (at) => at ? dayjs(at.replace(' ', 'T')).format('YYYY/M/D HH:mm') : '－'
  let busy = false

  window.refreshNotifBadge = async function () {
    try {
      const { data } = await axios.get('/api/admin/notifications/unread-count')
      const el = document.getElementById('notif-badge'); if (!el) return
      el.textContent = data.count; el.classList.toggle('hidden', !data.count)
    } catch (e) { }
    if (window.refreshCorrectionsBadge) refreshCorrectionsBadge()
  }
  // バッジの定期更新は、ログインの期限切れ・アカウントの切り替えの後は止める（admin.js の sessionUsable。#526）
  const pollable = () => !window.sessionUsable || window.sessionUsable()
  setTimeout(() => { if (pollable()) window.refreshNotifBadge() }, 1000)
  setInterval(() => { if (!document.hidden && pollable()) window.refreshNotifBadge() }, 60000)

  // ---------- 通知（受信箱）----------
  window.renderNotificationsInbox = async function () {
    loading()
    let d; try { d = (await axios.get('/api/admin/notifications')).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    $app.innerHTML = `
      <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 class="text-xl font-bold text-gray-800"><i class="fas fa-bell text-blue-600 mr-1"></i>通知 ${d.unread ? `<span class="badge badge-red">${d.unread}件 未読</span>` : ''}</h2>
        ${d.unread ? '<button class="btn btn-outline text-sm" onclick="notifReadAll(this)">すべて既読にする</button>' : ''}
      </div>
      <div class="space-y-2">${d.notifications.map(n => `
        <button class="card p-3 w-full text-left block ${n.read_at ? '' : 'ring-1 ring-blue-200'}" data-action="notifOpen" data-id="${n.notification_id}" data-link="${esc(n.link || '')}">
          <div class="flex items-center gap-2">${n.read_at ? '' : '<span class="w-2 h-2 rounded-full bg-blue-500 shrink-0"></span>'}<span class="badge badge-gray text-[10px]">${KIND[n.kind] || ''}</span>${processedBadge(n)}
            <span class="text-[11px] text-gray-400 ml-auto">${esc(fmtAt(n.created_at))}</span></div>
          <p class="font-bold text-gray-800 mt-1 text-sm">${esc(n.title)}</p>
          <p class="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">${esc(n.body || '')}</p>
        </button>`).join('') || '<p class="text-center text-gray-400 py-10">通知はありません</p>'}</div>`
    window.refreshNotifBadge()
  }
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
  window.notifReadAll = async function (btn) {
    btn.disabled = true
    try { await axios.post('/api/admin/notifications/read-all') } catch (e) { toast(errMsg(e)) }
    renderNotificationsInbox()
  }

  // ---------- メール送信状況（送信失敗・再送）----------
  let EMAIL_STATUS = 'failed'
  window.renderCorrectionEmails = async function () {
    loading()
    let d; try { d = (await axios.get('/api/admin/notification-emails', { params: { status: EMAIL_STATUS } })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    const n = d.counts || {}
    const tab = (k, l) => `<button class="px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${EMAIL_STATUS === k ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600'}" onclick="mailTab('${k}')">${l}${n[k] ? ` <span class="text-xs opacity-80">${n[k]}</span>` : ''}</button>`
    const st = (s) => s === 'sent' ? '<span class="badge badge-green whitespace-nowrap">送信済み</span>' : s === 'failed' ? '<span class="badge badge-red whitespace-nowrap">送信失敗</span>' : '<span class="badge badge-yellow whitespace-nowrap">送信中</span>'
    const rows = d.deliveries
    // 宛先が停止中のものは再送できない（サーバーも受け付けない）
    const resendable = (r) => r.status === 'failed' && r.error !== 'recipient_suspended' && r.error !== 'already_processed'
    const action = (r) => resendable(r) ? `<button class="btn btn-outline text-xs whitespace-nowrap" onclick="mailResend(${r.delivery_id}, this)"><i class="fas fa-rotate"></i>再送</button>` : ''
    $app.innerHTML = `
      <a href="#corrections" class="text-sm text-blue-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>打刻修正承認</a>
      <div class="flex items-center justify-between flex-wrap gap-2 mt-2"><h2 class="text-xl font-bold text-gray-800"><i class="fas fa-envelope text-blue-600 mr-1"></i>メール送信状況</h2>
        <a class="btn btn-outline text-sm" href="/api/admin/notification-emails/export${EMAIL_STATUS === 'all' ? '' : '?status=' + EMAIL_STATUS}"><i class="fas fa-file-csv"></i>CSV 出力</a></div>
      <p class="text-xs text-gray-500 mt-1 mb-3">打刻修正申請の通知メールの送信結果です。送信に失敗しても申請・承認は保存されています。失敗したメールは再送できます（再送の結果も記録します）</p>
      <div class="flex gap-2 overflow-x-auto pb-1 mb-3">${tab('failed', '送信失敗')}${tab('pending', '送信中')}${tab('sent', '送信済み')}${tab('all', 'すべて')}</div>
      <div class="hidden md:block card overflow-x-auto"><table class="tbl">
        <thead><tr><th>状態</th><th>通知</th><th>宛先</th><th>申請</th><th>理由</th><th>試行</th><th>最終送信</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${st(r.status)}</td><td class="text-xs whitespace-nowrap">${EVENT[r.event] || esc(r.event)}・${KIND[r.kind] || ''}</td>
          <td class="text-xs">${esc(r.recipient_name || '')}<br><span class="text-gray-400">${esc(r.to_email)}</span></td>
          <td class="text-xs"><a class="text-blue-600 hover:underline" href="#corrections/${r.correction_id}">#${r.correction_id}</a> ${esc(r.staff_name || '')} ${r.work_date ? dayjs(r.work_date).format('M/D') : ''} ${LABEL[r.report_type] || ''}</td>
          <td class="text-xs text-red-600">${esc(r.error ? (ERR[r.error] || r.error) : '')}</td><td class="text-xs">${r.attempts}回</td>
          <td class="text-xs whitespace-nowrap">${esc(fmtAt(r.last_attempt_at))}${r.last_attempt_by_name ? '<br><span class="text-gray-400">再送: ' + esc(r.last_attempt_by_name) + '</span>' : ''}</td><td>${action(r)}</td></tr>`).join('') || '<tr><td colspan="8" class="text-center text-gray-400 py-6">該当するメールはありません</td></tr>'}</tbody></table></div>
      <div class="md:hidden space-y-2">${rows.map(r => `<div class="card p-3">
        <div class="flex items-center justify-between gap-2">${st(r.status)}<span class="text-[11px] text-gray-400">${r.attempts}回 ・${esc(fmtAt(r.last_attempt_at))}</span></div>
        <p class="text-sm font-bold mt-1">${esc(r.recipient_name || '')} <span class="text-xs font-normal text-gray-500">${EVENT[r.event] || ''}・${KIND[r.kind] || ''}</span></p>
        <p class="text-xs text-gray-500 break-all">${esc(r.to_email)}</p>
        <p class="text-xs mt-1"><a class="text-blue-600" href="#corrections/${r.correction_id}">#${r.correction_id}</a> ${esc(r.staff_name || '')} ${LABEL[r.report_type] || ''}</p>
        ${r.error ? `<p class="text-xs text-red-600 mt-1">${esc(ERR[r.error] || r.error)}</p>` : ''}
        ${resendable(r) ? `<div class="mt-2">${action(r).replace('btn-outline text-xs whitespace-nowrap', 'btn-outline text-xs w-full')}</div>` : ''}</div>`).join('') || '<p class="text-center text-gray-400 py-6">該当するメールはありません</p>'}</div>`
  }
  window.mailTab = function (k) { EMAIL_STATUS = k; renderCorrectionEmails() }
  window.mailResend = async function (id, btn) {
    if (busy) return
    busy = true; btn.disabled = true
    try {
      const { data } = await axios.post(`/api/admin/notification-emails/${id}/resend`)
      toast(data.sent ? '再送しました' : `再送に失敗しました（${ERR[data.error] || data.error}）`)
    } catch (e) { toast(errMsg(e)) } finally { busy = false; renderCorrectionEmails() }
  }
})()
