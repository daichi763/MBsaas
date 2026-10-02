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
  const opt = document.querySelector('#mobile-nav option[value="roster-chat"]')
  if (opt) opt.textContent = '企業間チャット' + (n ? `（${n}）` : '')
  return n
}
window.refreshChatBadge = refreshChatBadge
setInterval(refreshChatBadge, 60 * 1000)
setTimeout(refreshChatBadge, 500)

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
          <a href="#staff/${t.open_staff_id}" onclick="window.__chatHost='${t.my_side === 'owner' ? t.thread_staff_id : ''}'" class="flex items-center gap-2 text-sm p-2 rounded-lg hover:bg-gray-50">
            <span class="badge badge-red">${t.unread}</span>
            <span class="font-medium text-gray-800">${esc(t.staff_name)}</span>
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
      <span class="text-sm text-gray-400">未読 ${data.unread_total}件</span>
    </div>
    <p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 mb-4"><i class="fas fa-eye-slash mr-1"></i>${CHAT_NOTICE}</p>
    <section class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>スタッフ</th><th>相手企業</th><th>自社の立場</th><th>最新メッセージ</th><th>日時</th><th>未読</th></tr></thead>
        <tbody>
          ${data.threads.map(t => `
            <tr class="cursor-pointer" onclick="window.__chatHost='${t.my_side === 'owner' ? t.thread_staff_id : ''}'; location.hash='staff/${t.open_staff_id}'">
              <td class="font-medium text-blue-700">${esc(t.staff_name)}</td>
              <td>${esc(t.partner_company_name)}</td>
              <td>${t.my_side === 'owner' ? '<span class="badge badge-green">所属元</span>' : '<span class="badge badge-blue">稼働先</span>'}</td>
              <td class="text-xs text-gray-600 max-w-[320px] truncate">${esc(t.last_body || '—')}</td>
              <td class="text-xs text-gray-400">${t.last_at ? esc(t.last_at.slice(5, 16)) : ''}</td>
              <td>${t.unread ? `<span class="badge badge-red">${t.unread}</span>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="text-center text-gray-400 py-6">連携中のスタッフがいません（①QR/ID連携で登録すると、所属元企業とのチャットが利用できます）</td></tr>'}
        </tbody>
      </table>
    </section>`
  refreshChatBadge()
}

// ---------- スタッフ詳細のチャット欄 ----------
// 稼働先: その連携行のスレッド1本 / 所属元: 連携先企業ごとのスレッド（タブ切替）
window.renderRosterChatPanel = async function (sid, p) {
  const host = document.getElementById('roster-chat-panel')
  if (!host) return
  // 所属元（1つ前の企業）とのスレッド + 自社から連携した先（直接の連携先のみ）とのスレッド
  let threads = []
  if (p.affiliation_type === 'linked_external') threads.push({ key: '', label: (p.owner_company_name || '所属元') + '（所属元）' })
  if (p.linkable) {
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
        ${threads.length > 1 ? `<select id="chat-thread-sel" class="inp text-xs w-auto" onchange="loadRosterChat(${sid}, this.value)">
          ${threads.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select>` : `<span class="text-xs text-gray-500">相手: ${esc(threads[0].label)}</span>`}
      </div>
      <p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 mb-3"><i class="fas fa-eye-slash mr-1"></i>${CHAT_NOTICE}</p>
      <div id="chat-log" class="space-y-2 max-h-80 overflow-y-auto p-1 bg-gray-50 rounded-lg"></div>
      <div class="flex gap-2 mt-3">
        <textarea id="chat-input" rows="2" maxlength="2000" class="inp text-sm flex-1" placeholder="メッセージを入力（Ctrl+Enterで送信）"></textarea>
        <button class="btn btn-primary self-end" onclick="sendRosterChat(${sid})"><i class="fas fa-paper-plane"></i>送信</button>
      </div>
    </section>`
  document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendRosterChat(sid) })
  // 一覧・ダッシュボードから遷移した場合は該当スレッドを開いてチャット欄までスクロール
  const want = window.__chatHost; window.__chatHost = null
  const initial = want && threads.some(t => t.key === String(want)) ? String(want) : threads[0].key
  const sel = document.getElementById('chat-thread-sel'); if (sel) sel.value = initial
  loadRosterChat(sid, initial)
  if (want !== null && want !== undefined) host.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

let CHAT_CUR = { sid: null, hostKey: '' }
window.loadRosterChat = async function (sid, hostKey) {
  CHAT_CUR = { sid, hostKey: hostKey || '' }
  const log = document.getElementById('chat-log'); if (!log) return
  try {
    const { data } = await axios.get(`/api/admin/roster-chat/${sid}`, { params: hostKey ? { host_staff_id: hostKey } : {} })
    log.innerHTML = data.messages.map(m => `
      <div class="flex ${m.mine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.mine ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-800'}">
          <p class="text-[10px] ${m.mine ? 'text-blue-100' : 'text-gray-400'} mb-0.5">${esc(m.author_company_name)} ・ ${esc(m.author_name || '')} ・ ${esc((m.created_at || '').slice(5, 16))}</p>
          <p class="whitespace-pre-wrap break-words">${esc(m.body)}</p>
        </div>
      </div>`).join('') || '<p class="text-xs text-gray-400 text-center py-6">まだメッセージはありません</p>'
    log.scrollTop = log.scrollHeight
    refreshChatBadge()
  } catch { log.innerHTML = '<p class="text-xs text-red-500 text-center py-6">読み込みに失敗しました</p>' }
}
window.sendRosterChat = async function (sid) {
  const el = document.getElementById('chat-input'); const body = el.value.trim()
  if (!body) return
  try {
    await axios.post(`/api/admin/roster-chat/${sid}`, { body, host_staff_id: CHAT_CUR.hostKey || undefined })
    el.value = ''; loadRosterChat(sid, CHAT_CUR.hostKey)
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '送信に失敗しました') }
}

// ルート追加（admin.js の routes に登録）
if (typeof routes === 'object') routes['roster-chat'] = window.renderRosterChatList
