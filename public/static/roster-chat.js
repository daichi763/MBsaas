// Field OS 管理画面: 企業間チャット（所属元 ⇔ 稼働先 担当者）フェーズG
// ※このファイルは管理画面（/admin）でのみ読み込む。スタッフ画面（/staff）では絶対に読み込まないこと。
const CHAT_NOTICE = 'このやり取りはスタッフ本人には表示されません（所属元企業・稼働先企業の担当者のみ閲覧できます）'

// ---------- 未読バッジ（サイドバー / モバイルメニュー） ----------
async function refreshChatBadge() {
  let n = 0
  try { n = (await axios.get('/api/admin/roster-chat/unread-count')).data.unread } catch { return }
  const link = document.querySelector('.side-link[data-tab="roster-chat"]')
  if (link) {
    let b = link.querySelector('.chat-badge')
    if (!b) { b = document.createElement('span'); b.className = 'chat-badge ml-auto badge badge-red'; link.appendChild(b) }
    b.textContent = n; b.style.display = n ? '' : 'none'
  }
  if (window.setNavCount) setNavCount('roster-chat', n)
  return n
}
window.refreshChatBadge = refreshChatBadge
// 定期更新は、ログインの期限切れ・アカウントの切り替えの後は止める（admin.js の sessionUsable。#526）
const chatPollable = () => !window.sessionUsable || window.sessionUsable()
setInterval(() => { if (!document.hidden && chatPollable()) refreshChatBadge() }, 60 * 1000)
setTimeout(() => { if (chatPollable()) refreshChatBadge() }, 500)

// ---------- ダッシュボード通知（新着のみ表示） ----------
window.renderChatDashboardNotice = async function () {
  let data
  try { data = (await axios.get('/api/admin/roster-chat/threads')).data } catch { return }
  const unread = data.threads.filter(t => t.unread > 0)
  refreshChatBadge()
  if (!unread.length) return
  const app = document.getElementById('app')
  if (!app || !app.firstElementChild || document.getElementById('chat-dashboard-notice')) return
  const html = `
    <section id="chat-dashboard-notice" class="card p-4 mb-5 border-l-4 border-blue-500">
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-bold text-gray-800"><i class="fas fa-comments text-blue-600 mr-1"></i>企業間チャット 新着 <span class="badge badge-red">${data.unread_total}</span></h3>
        <a href="#roster-chat" class="text-xs text-blue-600 hover:underline">すべて見る</a>
      </div>
      <div class="space-y-1">
        ${unread.slice(0, 5).map(t => `
          <a href="#roster-chat" ${chatOpenAttrs(t)} class="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-gray-50">
            <span class="badge badge-red">${Number(t.unread)}</span>
            <span class="font-medium text-gray-800">${esc(t.staff_name || '（削除済み）')}</span>${t.ended ? '<span class="badge badge-gray">連携終了</span>' : ''}
            <span class="text-xs text-gray-400">${esc(t.partner_company_name)}</span>
            <span class="text-xs text-gray-500 truncate flex-1">${esc(t.last_body || '')}</span>
          </a>`).join('')}
      </div>
    </section>`
  // ダッシュボード見出しの直後に差し込む
  app.firstElementChild.insertAdjacentHTML('afterend', html)
}

// ---------- 一覧画面（#roster-chat） ----------
window.renderRosterChatList = async function () {
  loading()
  const { data } = await axios.get('/api/admin/roster-chat/threads')
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">企業間チャット</h2>
      <span class="text-sm text-gray-400">未読 ${data.unread_total}件 ・ <a href="#roster-notes" class="text-blue-600 hover:underline">連携先からの追記（現場評価・稼働メモ）</a></span>
    </div>
    <p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 mb-4"><i class="fas fa-eye-slash mr-1"></i>${CHAT_NOTICE}</p>
    <section class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>スタッフ</th><th>相手企業</th><th>自社の立場</th><th>最新メッセージ</th><th>日時</th><th>未読</th></tr></thead>
        <tbody>
          ${data.threads.map(t => `
            <tr class="cursor-pointer" ${chatOpenAttrs(t)}>
              <td class="font-medium text-blue-700">${esc(t.staff_name || '（削除済み）')}${t.ended ? ' <span class="badge badge-gray" title="区分の変更などで連携が終わったスレッドです。閲覧のみできます">連携終了</span>' : ''}</td>
              <td>${esc(t.partner_company_name)}</td>
              <td>${t.my_side === 'owner' ? '<span class="badge badge-green">所属元</span>' : '<span class="badge badge-blue">稼働先</span>'}</td>
              <td class="text-xs text-gray-600 max-w-[320px] truncate">${esc(t.last_body || '—')}</td>
              <td class="text-xs text-gray-400">${t.last_at ? esc(t.last_at.slice(5, 16)) : ''}</td>
              <td>${t.unread ? `<span class="badge badge-red">${Number(t.unread)}</span>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="text-center text-gray-400 py-6">連携中のスタッフがいません（①QR/ID連携で登録すると、所属元企業とのチャットが利用できます）</td></tr>'}
        </tbody>
      </table>
    </section>`
  refreshChatBadge()
}

// 一覧・ダッシュボードからスレッドを開く。連携中はスタッフ詳細のチャット欄へ、連携が終わったスレッドは閲覧のみの画面を開く（#237）
function chatOpenAttrs(t) {
  return `data-action="openChatThread" data-thread="${Number(t.thread_staff_id)}" data-staff="${Number(t.open_staff_id) || ''}"`
    + ` data-host="${t.my_side === 'owner' ? Number(t.thread_staff_id) : ''}" data-ended="${t.ended ? '1' : ''}"`
}
delegate('openChatThread', (el, ev) => {
  if (ev) ev.preventDefault()
  if (el.dataset.ended) return openEndedChat(Number(el.dataset.thread))
  window.__chatHost = el.dataset.host || ''
  location.hash = 'staff/' + Number(el.dataset.staff)
})
async function openEndedChat(threadId) {
  let d
  try { d = (await axios.get(`/api/admin/roster-chat/ended/${Number(threadId)}`)).data } catch (e) { return toast((e.response && e.response.data && e.response.data.error) || '読み込みに失敗しました') }
  modal(`<h3 class="font-bold text-lg mb-1"><i class="fas fa-comments text-blue-600 mr-1"></i>企業間チャット（連携終了）</h3>
    <p class="text-xs text-gray-500 mb-2">${esc(d.thread.staff_name || '（削除済み）')} ・ 相手: ${esc(d.thread.partner_company_name || '')}（${d.thread.my_side === 'owner' ? '自社は所属元' : '自社は稼働先'}）</p>
    <p class="text-xs text-gray-600 bg-gray-50 rounded-lg p-2 mb-3">区分の変更などで連携が終わったため、閲覧のみできます（新しいメッセージは送れません）</p>
    <div class="space-y-2 max-h-96 overflow-y-auto p-1 bg-gray-50 rounded-lg" id="ended-chat-log">${d.messages.map(m => `
      <div class="flex ${m.mine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.mine ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-800'}">
          <p class="text-[10px] ${m.mine ? 'text-blue-100' : 'text-gray-400'} mb-0.5">${esc(m.author_company_name)} ・ ${esc(m.author_name || '')} ・ ${esc((m.created_at || '').slice(5, 16))}</p>
          <p class="whitespace-pre-wrap break-words">${esc(m.body)}</p>
        </div>
      </div>`).join('')}</div>
    <button class="btn btn-outline w-full mt-3" onclick="closeModal()">閉じる</button>`)
  // 開いたので既読になった。一覧の未読表示とバッジを更新する
  refreshChatBadge()
  if (location.hash === '#roster-chat') renderRosterChatList()
}

// ---------- スタッフ詳細のチャット欄 ----------
// 稼働先: その連携行のスレッド1本 / 所属元: 連携先企業ごとのスレッド（タブ切替）
window.renderRosterChatPanel = async function (sid, p) {
  const host = document.getElementById('roster-chat-panel')
  if (!host) return
  // 所属元（1つ前の企業）とのスレッド + 自社から連携した先（直接の連携先のみ）とのスレッド
  let threads = []
  if (p.affiliation_type === 'linked_external') threads.push({ key: '', label: (p.owner_company_name || '所属元') + '（所属元）' })
  // 連携先とのスレッドは、今の区分にかかわらず連携先があれば出す（自社雇用から区分を変えても連携は続くため。#140）。
  // 連携用QRを出せるかどうか（p.linkable）とは別に判断する
  if (!p.merged_into_staff_id) {
    try {
      const links = (await axios.get(`/api/admin/roster/${sid}/links`)).data
      threads.push(...(links.links || []).map(l => ({ key: String(l.linked_staff_id), label: l.host_company_name + '（連携先）' })))
    } catch { /* noop */ }
  }
  if (!threads.length) { host.classList.add('hidden'); return }
  host.classList.remove('hidden')
  host.innerHTML = `
    <section class="card p-4">
      <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-comments text-blue-600 mr-1"></i>企業間チャット</h3>
        ${threads.length > 1 ? `<select id="chat-thread-sel" class="inp text-xs w-auto">
          ${threads.map(t => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('')}</select>` : `<span class="text-xs text-gray-500">相手: ${esc(threads[0].label)}</span>`}
      </div>
      <p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 mb-3"><i class="fas fa-eye-slash mr-1"></i>${CHAT_NOTICE}</p>
      <div id="chat-log" class="space-y-2 max-h-80 overflow-y-auto p-1 bg-gray-50 rounded-lg"></div>
      <p id="chat-reads" class="text-[11px] text-gray-400 mt-1"></p>
      <div class="flex gap-2 mt-3">
        <textarea id="chat-input" rows="2" maxlength="2000" class="inp text-sm flex-1" placeholder="メッセージを入力（Ctrl+Enterで送信）"></textarea>
        <button class="btn btn-primary self-end" data-action="sendRosterChat" data-sid="${Number(sid)}"><i class="fas fa-paper-plane"></i>送信</button>
      </div>
    </section>`
  document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendRosterChat(sid) })
  const sel = document.getElementById('chat-thread-sel')
  // スレッドを選び直したのは、そのスレッドを読むための操作なので既読にする
  if (sel) sel.addEventListener('change', () => loadRosterChat(sid, sel.value, { markRead: true }))
  // 一覧・ダッシュボードから遷移した場合は該当スレッドを開いてチャット欄までスクロールし、既読にする。
  // スタッフ詳細を別の目的で開いただけのときは、チャット欄が画面に見えるまで既読にしない（#462）
  const want = window.__chatHost; window.__chatHost = null
  const initial = want && threads.some(t => t.key === String(want)) ? String(want) : threads[0].key
  if (sel) sel.value = initial
  const opened = want !== null && want !== undefined
  loadRosterChat(sid, initial, { markRead: opened })
  if (opened) host.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
delegate('sendRosterChat', (el) => sendRosterChat(Number(el.dataset.sid)))

let CHAT_CUR = { sid: null, hostKey: '' }
let CHAT_OBSERVER = null
// 既読にする（ユーザー単位）。表示中のメッセージの最後までを既読にし、バッジを更新する
async function markRosterChatRead(sid, hostKey, lastId) {
  if (!lastId) return
  try {
    await axios.post(`/api/admin/roster-chat/${sid}/read`, { host_staff_id: hostKey || undefined, last_comment_id: lastId })
    const mark = document.getElementById('chat-unread-mark'); if (mark) mark.remove()
    refreshChatBadge()
  } catch { /* 既読にできなくても表示は続ける */ }
}
// 自社の担当者の既読（相手の最新のメッセージまで読んだ人）
function chatReadsText(data) {
  const lastTheirs = data.messages.filter(m => !m.mine).reduce((a, m) => Math.max(a, m.comment_id), 0)
  if (!lastTheirs) return ''
  const readers = (data.reads || []).filter(r => r.last_read_comment_id >= lastTheirs)
  return readers.length ? '自社の既読: ' + readers.map(r => `${r.name || ''}${r.me ? '（自分）' : ''} ${(r.read_at || '').slice(5, 16)}`).join('、') : '自社ではまだ誰も最新のメッセージを読んでいません'
}
window.loadRosterChat = async function (sid, hostKey, opts) {
  CHAT_CUR = { sid, hostKey: hostKey || '' }
  if (CHAT_OBSERVER) { CHAT_OBSERVER.disconnect(); CHAT_OBSERVER = null }
  const log = document.getElementById('chat-log'); if (!log) return
  try {
    const { data } = await axios.get(`/api/admin/roster-chat/${sid}`, { params: hostKey ? { host_staff_id: hostKey } : {} })
    if (CHAT_CUR.sid !== sid || CHAT_CUR.hostKey !== (hostKey || '')) return // 読み込み中に別のスレッドへ切り替えた
    const myRead = Number(data.my_last_read_comment_id) || 0
    // 相手からの未読の始まりに印を付ける
    const firstUnread = data.messages.find(m => !m.mine && m.comment_id > myRead)
    log.innerHTML = data.messages.map(m => `
      ${firstUnread && m.comment_id === firstUnread.comment_id ? '<p id="chat-unread-mark" class="text-[11px] text-red-500 text-center border-t border-red-200 pt-1">ここから未読</p>' : ''}
      <div class="flex ${m.mine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.mine ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-800'}">
          <p class="text-[10px] ${m.mine ? 'text-blue-100' : 'text-gray-400'} mb-0.5">${esc(m.author_company_name)} ・ ${esc(m.author_name || '')} ・ ${esc((m.created_at || '').slice(5, 16))}</p>
          <p class="whitespace-pre-wrap break-words">${esc(m.body)}</p>
        </div>
      </div>`).join('') || '<p class="text-xs text-gray-400 text-center py-6">まだメッセージはありません</p>'
    log.scrollTop = log.scrollHeight
    const readsEl = document.getElementById('chat-reads'); if (readsEl) readsEl.textContent = chatReadsText(data)
    const lastId = data.messages.length ? data.messages[data.messages.length - 1].comment_id : 0
    if (!firstUnread) return
    if (opts && opts.markRead) { markRosterChatRead(sid, hostKey, lastId); return }
    // チャット欄の半分以上が2秒続けて見えたら既読にする（スクロールして読んだとき。通り過ぎただけでは既読にしない）
    if ('IntersectionObserver' in window) {
      let timer = null
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.some(e => e.isIntersecting)
        if (!visible || document.hidden) { clearTimeout(timer); timer = null; return }
        if (timer) return
        timer = setTimeout(() => {
          observer.disconnect(); if (CHAT_OBSERVER === observer) CHAT_OBSERVER = null
          if (CHAT_CUR.sid === sid && CHAT_CUR.hostKey === (hostKey || '') && document.body.contains(log)) markRosterChatRead(sid, hostKey, lastId)
        }, 2000)
      }, { threshold: 0.5 })
      CHAT_OBSERVER = observer
      observer.observe(log)
    }
  } catch { log.innerHTML = '<p class="text-xs text-red-500 text-center py-6">読み込みに失敗しました</p>' }
}
// 送信中は送信ボタンと Ctrl+Enter を止め、入力欄は送る前に空にする（失敗したら戻す）。
// 二度押しで同じメッセージが相手に2件届かないように（#263）
let CHAT_SENDING = false
window.sendRosterChat = async function (sid) {
  const el = document.getElementById('chat-input'); const body = el.value.trim()
  if (!body || CHAT_SENDING) return
  const button = el.parentElement ? el.parentElement.querySelector('button') : null
  CHAT_SENDING = true
  el.value = ''
  try {
    await withSubmitLock(button, async () => {
      try {
        await axios.post(`/api/admin/roster-chat/${sid}`, { body, host_staff_id: CHAT_CUR.hostKey || undefined })
        loadRosterChat(sid, CHAT_CUR.hostKey, { markRead: true })
      } catch (e) {
        if (!el.value) el.value = body
        showApiError(e, '送信に失敗しました')
      }
    })
  } finally { CHAT_SENDING = false }
}

// ルート追加（admin.js の routes に登録）
if (typeof routes === 'object') routes['roster-chat'] = window.renderRosterChatList
