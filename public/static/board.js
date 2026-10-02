// =========================================================
// 案件掲示板（管理画面 #board）第1段階: 掲載・一覧・詳細（docs/spec_board.md）
// admin.js の後に読み込む。#board = 一覧 / #board/new = 新規 / #board/123 = 詳細 / #board/123-edit = 編集
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const fmtD = (d) => { if (!d) return ''; const x = dayjs(d); return `${x.format('YYYY/M/D')}(${WD[x.day()]})` }
  const ENG = { regular: '常勤', spot: 'スポット' }
  const ENG_BADGE = { regular: 'badge-blue', spot: 'badge-purple' }
  const UNIT = { hourly: '時給', daily: '日給', monthly: '月給' }
  const STATUS = { draft: '下書き', open: '掲載中', closed: '締切', filled: '充足' }
  const STATUS_BADGE = { draft: 'badge-gray', open: 'badge-green', closed: 'badge-gray', filled: 'badge-yellow' }
  const PRICE_NOTES = ['スキルにより交渉可能', '応相談', '経験者優遇', '交通費別途支給', '交通費込み', '残業代別途']
  const PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
    '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
  // シフトボード（shift-board.js）の window.__boardState と衝突しないよう別名にする
  const S = window.__jobBoardState = window.__jobBoardState || { eng: 'regular', scope: 'open', filters: {} }
  if (!S.filters) S.filters = {}
  let projectsCache = null

  const priceText = (p) => `${UNIT[p.price_unit] || ''} ${Number(p.price_amount || 0).toLocaleString()}円`
  const placeText = (p) => [p.prefecture, p.area].filter(Boolean).join(' ') + (p.nearest_station ? `（${p.nearest_station}）` : '')
  const scheduleText = (p) => {
    const d = p.engagement_type === 'spot'
      ? (p.date_to && p.date_to !== p.date_from ? `${fmtD(p.date_from)}〜${fmtD(p.date_to)}` : fmtD(p.date_from))
      : `${p.date_from ? fmtD(p.date_from) + '〜' : ''}${p.date_to ? fmtD(p.date_to) : (p.date_from ? '長期' : '')}`
    const t = p.time_from || p.time_to ? ` ${p.time_from || ''}〜${p.time_to || ''}` : ''
    return (d + t).trim()
  }
  const skillBadges = (s) => String(s || '').split(',').filter(Boolean).map(x => `<span class="badge badge-blue">${esc(x)}</span>`).join(' ')

  window.renderBoard = function (id) {
    if (!id) return renderList()
    if (id === 'new') return renderForm(null)
    if (id === 'threads') return renderThreadList()
    const tm = String(id).match(/^t(\d+)$/)
    if (tm) return renderThread(Number(tm[1]))
    const m = String(id).match(/^(\d+)(-edit)?$/)
    if (!m) return renderList()
    return m[2] ? renderForm(Number(m[1])) : renderDetail(Number(m[1]))
  }

  // ---------- 一覧 ----------
  async function renderList() {
    loading()
    $app.innerHTML = `
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 class="text-xl font-bold text-gray-900"><i class="fas fa-clipboard-list text-blue-600 mr-1"></i>案件掲示板</h2>
          <p class="text-xs text-gray-500 mt-1">利用企業どうしで案件を掲載・閲覧できます。掲載内容と掲載企業名は全利用企業に公開されます</p>
        </div>
        <a class="btn btn-primary text-sm" href="#board/new" id="board-new"><i class="fas fa-plus"></i>案件を掲載</a>
      </div>
      <div class="flex gap-1 mb-3 flex-wrap items-center" id="board-eng-tabs">
        ${['regular', 'spot'].map(k => `<button class="btn ${S.eng === k ? 'btn-primary' : 'btn-outline'} text-sm" data-eng="${k}" onclick="__boardSet('eng','${k}')">${ENG[k]} <span class="board-count text-xs opacity-80" data-k="${k}"></span></button>`).join('')}
        <span class="mx-2 text-gray-300">|</span>
        ${[['open', '掲載中の案件'], ['mine', '自社の掲載']].map(([k, l]) => `<button class="btn ${S.scope === k ? 'btn-primary' : 'btn-outline'} text-xs" data-scope="${k}" onclick="__boardSet('scope','${k}')">${l}</button>`).join('')}
        <a class="btn btn-outline text-xs" href="#board/threads" id="board-threads-link"><i class="fas fa-comments"></i>やり取り一覧<span class="board-unread-total hidden ml-1 badge badge-red"></span></a>
      </div>
      <section class="card p-3 mb-3" id="board-filters">
        <div class="grid md:grid-cols-6 gap-2 text-xs">
          <select id="bf-pref" class="inp text-xs"><option value="">都道府県（すべて）</option>${PREFS.map(p => `<option ${S.filters.prefecture === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
          <input id="bf-area" class="inp text-xs" placeholder="エリア・駅" value="${esc(S.filters.area || '')}">
          <input id="bf-date" type="date" class="inp text-xs" title="稼働日（この日を含む案件）" value="${esc(S.filters.date || '')}">
          <input id="bf-skill" class="inp text-xs" placeholder="スキル（例: MNP）" value="${esc(S.filters.skill || '')}">
          <input id="bf-q" class="inp text-xs" placeholder="キーワード（案件名・企業名）" value="${esc(S.filters.q || '')}">
          <div class="flex gap-1">
            <button class="btn btn-primary text-xs flex-1" onclick="__boardSearch()"><i class="fas fa-magnifying-glass"></i>検索</button>
            <button class="btn btn-outline text-xs" title="条件をクリア" onclick="__boardClear()"><i class="fas fa-xmark"></i></button>
          </div>
        </div>
        ${S.scope === 'open' ? `<label class="text-xs text-gray-500 mt-2 inline-flex items-center gap-1"><input type="checkbox" id="bf-hide-mine" ${S.filters.hide_mine ? 'checked' : ''} onchange="__boardSearch()">自社の掲載を除く</label>` : ''}
      </section>
      <section id="board-list"><div class="flex justify-center py-10"><span class="spin"></span></div></section>`
    $app.querySelectorAll('#board-filters input').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') window.__boardSearch() }))
    await loadList()
  }
  window.__boardSet = function (k, v) { S[k] = v; renderList() }
  window.__boardSearch = function () {
    const g = id => (document.getElementById(id) || {}).value || ''
    S.filters = { prefecture: g('bf-pref'), area: g('bf-area').trim(), date: g('bf-date'), skill: g('bf-skill').trim(), q: g('bf-q').trim(),
      hide_mine: !!(document.getElementById('bf-hide-mine') || {}).checked }
    loadList()
  }
  window.__boardClear = function () { S.filters = {}; renderList() }

  async function loadList() {
    const box = document.getElementById('board-list'); if (!box) return
    const f = S.filters
    try {
      const { data } = await axios.get('/api/admin/board/posts', { params: {
        scope: S.scope, engagement_type: S.eng, prefecture: f.prefecture || undefined, area: f.area || undefined, date: f.date || undefined,
        skill: f.skill || undefined, q: f.q || undefined, hide_mine: f.hide_mine ? '1' : undefined } })
      window.refreshBoardBadge()
      document.querySelectorAll('.board-count').forEach(el => { const n = (data.open_counts || {})[el.dataset.k] || 0; el.textContent = n ? `(${n})` : '' })
      if (!data.posts.length) {
        box.innerHTML = `<div class="card p-8 text-center text-sm text-gray-400">${S.scope === 'mine' ? `自社の${ENG[S.eng]}の掲載はまだありません。<a class="text-blue-600 underline" href="#board/new">案件を掲載</a>` : `条件に合う${ENG[S.eng]}の掲載はありません`}</div>`
        return
      }
      box.innerHTML = `<div class="grid md:grid-cols-2 gap-3">${data.posts.map(cardHtml).join('')}</div>`
    } catch (e) { box.innerHTML = `<div class="card p-6 text-center text-sm text-red-500">${esc(errMsg(e, '読み込みに失敗しました'))}</div>` }
  }

  function cardHtml(p) {
    return `
      <a href="#board/${p.post_id}" class="card p-4 block hover:shadow-md transition board-card" data-post="${p.post_id}">
        <div class="flex items-start gap-2 mb-1">
          <span class="badge ${ENG_BADGE[p.engagement_type]}">${ENG[p.engagement_type]}</span>
          ${p.is_mine || p.status !== 'open' ? `<span class="badge ${STATUS_BADGE[p.status]}">${STATUS[p.status]}</span>` : ''}
          ${p.is_mine ? '<span class="badge badge-gray">自社</span>' : ''}
          <span class="ml-auto text-[11px] text-gray-400">${p.published_at ? esc(p.published_at.slice(0, 10)) + ' 掲載' : '未掲載'}</span>
        </div>
        <h3 class="font-bold text-gray-900 leading-snug">${esc(p.title)}</h3>
        <p class="text-xs text-gray-500 mt-0.5"><i class="fas fa-building mr-1 text-gray-400"></i>${esc(p.company_name)}</p>
        <div class="mt-2 grid grid-cols-1 gap-0.5 text-xs text-gray-700">
          <p><i class="fas fa-location-dot w-4 text-gray-400"></i>${esc(placeText(p) || '-')}</p>
          <p><i class="fas fa-calendar w-4 text-gray-400"></i>${esc(scheduleText(p) || '-')}${p.schedule_note ? ` <span class="text-gray-500">／${esc(p.schedule_note)}</span>` : ''}</p>
          <p><i class="fas fa-yen-sign w-4 text-gray-400"></i><span class="font-bold text-gray-900">${esc(priceText(p))}</span>${p.price_note ? ` <span class="text-amber-700">（${esc(p.price_note)}）</span>` : ''}
            <span class="ml-2 text-gray-500"><i class="fas fa-user-group mr-0.5"></i>${p.headcount}名</span></p>
        </div>
        ${p.required_skills ? `<div class="mt-2 flex flex-wrap gap-1">${skillBadges(p.required_skills)}</div>` : ''}
        <div class="flex items-center gap-2 mt-2 text-[11px]">
          ${p.deadline ? `<span class="text-gray-400">締切 ${esc(fmtD(p.deadline))}</span>` : ''}
          ${p.thread_count ? `<span class="ml-auto text-blue-700"><i class="fas fa-comments mr-0.5"></i>${p.is_mine ? `問い合わせ ${p.thread_count}社` : 'やり取り中'}</span>` : ''}
          ${p.unread ? `<span class="badge badge-red ${p.thread_count ? '' : 'ml-auto'}">未読 ${p.unread}</span>` : ''}
        </div>
      </a>`
  }

  // ---------- 詳細 ----------
  async function renderDetail(id) {
    loading()
    let p
    try { p = (await axios.get('/api/admin/board/posts/' + id)).data.post } catch (e) {
      $app.innerHTML = `<div class="card p-8 text-center text-sm text-gray-500">${esc(errMsg(e, '掲載が見つかりません'))}<br><a class="text-blue-600 underline" href="#board">一覧に戻る</a></div>`; return
    }
    S.eng = p.engagement_type
    const row = (l, v) => v ? `<div class="flex gap-3 py-2 border-b border-gray-100"><dt class="w-28 shrink-0 text-gray-400">${l}</dt><dd class="flex-1 min-w-0">${v}</dd></div>` : ''
    $app.innerHTML = `
      <div class="flex items-center gap-3 mb-4 flex-wrap">
        <a href="#board" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
        <div class="flex-1 min-w-0">
          <div class="flex gap-2 mb-1 flex-wrap">
            <span class="badge ${ENG_BADGE[p.engagement_type]}">${ENG[p.engagement_type]}</span>
            <span class="badge ${STATUS_BADGE[p.status]}">${STATUS[p.status]}</span>
            ${p.is_mine ? '<span class="badge badge-gray">自社の掲載</span>' : ''}
          </div>
          <h2 class="text-xl font-bold text-gray-900">${esc(p.title)}</h2>
          <p class="text-sm text-gray-500"><i class="fas fa-building mr-1 text-gray-400"></i>${esc(p.company_name)}</p>
        </div>
        ${p.is_mine ? `
          <div class="flex gap-2 flex-wrap" id="board-owner-actions">
            <a class="btn btn-outline text-sm" href="#board/${p.post_id}-edit"><i class="fas fa-pen"></i>編集</a>
            ${p.status === 'draft' ? `<button class="btn btn-primary text-sm" onclick="__boardStatus(${p.post_id},'open')"><i class="fas fa-paper-plane"></i>掲載する</button>
               <button class="btn btn-outline text-sm text-red-600" onclick="__boardDelete(${p.post_id})"><i class="fas fa-trash"></i>削除</button>` : ''}
            ${p.status === 'open' ? `<button class="btn btn-outline text-sm" onclick="__boardStatus(${p.post_id},'filled')"><i class="fas fa-check"></i>充足にする</button>
               <button class="btn btn-outline text-sm" onclick="__boardStatus(${p.post_id},'closed')"><i class="fas fa-ban"></i>締め切る</button>` : ''}
            ${p.status === 'closed' || p.status === 'filled' ? `<button class="btn btn-outline text-sm" onclick="__boardStatus(${p.post_id},'open')"><i class="fas fa-rotate-right"></i>再掲載</button>` : ''}
            <button class="btn btn-outline text-sm" onclick="__boardDuplicate(${p.post_id})"><i class="fas fa-copy"></i>複製</button>
          </div>` : ''}
      </div>
      <div class="grid lg:grid-cols-3 gap-4">
        <section class="card p-5 lg:col-span-2" id="board-detail">
          <div class="bg-blue-50 rounded-xl p-4 mb-4 flex items-center gap-4 flex-wrap">
            <div><p class="text-xs text-blue-700">単価</p><p class="text-2xl font-bold text-blue-900">${esc(priceText(p))}</p></div>
            ${p.price_note ? `<span class="badge badge-yellow">${esc(p.price_note)}</span>` : ''}
            <div class="ml-auto text-right"><p class="text-xs text-blue-700">募集人数</p><p class="text-xl font-bold text-blue-900">${p.headcount}名</p></div>
          </div>
          <dl class="text-sm">
            ${row('勤務地', esc(placeText(p)))}
            ${row(p.engagement_type === 'spot' ? '実施日時' : '期間・時間', esc(scheduleText(p)))}
            ${row('勤務条件', esc(p.schedule_note || ''))}
            ${row('求めるスキル', p.required_skills ? `<div class="flex flex-wrap gap-1">${skillBadges(p.required_skills)}</div>` : '')}
            ${row('締切', p.deadline ? esc(fmtD(p.deadline)) : '')}
            ${row('掲載日', p.published_at ? esc(p.published_at.slice(0, 16)) : '')}
            ${p.is_mine && p.source_project_name ? row('コピー元案件', `${esc(p.source_project_name)} <span class="text-xs text-gray-400">（自社のみ表示）</span>`) : ''}
          </dl>
          <h3 class="text-sm font-bold text-gray-700 mt-5 mb-2">業務内容・詳細</h3>
          <div class="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">${esc(p.description || '（記載なし）')}</div>
        </section>
        <aside class="space-y-4">
          <section class="card p-4" id="board-contact">
            <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-comments text-blue-600 mr-1"></i>この案件について</h3>
            ${p.is_mine ? `
              <p class="text-xs text-gray-500 mb-2">問い合わせ企業とのやり取り（企業ごとに1対1）</p>
              <div id="board-post-threads" class="space-y-1.5"><div class="flex justify-center py-3"><span class="spin"></span></div></div>`
            : p.my_thread ? `
              <p class="text-xs text-gray-500 mb-3">掲載企業: <span class="font-bold text-gray-700">${esc(p.company_name)}</span></p>
              <a class="btn btn-primary w-full text-sm" href="#board/t${p.my_thread.thread_id}" id="board-open-thread"><i class="fas fa-comment-dots"></i>やり取りを開く${p.my_thread.unread ? ` <span class="badge badge-red">${p.my_thread.unread}</span>` : ''}</a>
              <p class="text-[11px] text-gray-400 mt-2">人材の提案は次の段階で、このやり取りの中から行えるようになります。</p>`
            : p.status === 'open' ? `
              <p class="text-xs text-gray-500 mb-2">掲載企業: <span class="font-bold text-gray-700">${esc(p.company_name)}</span></p>
              <textarea id="board-first-msg" rows="4" maxlength="2000" class="inp text-sm" placeholder="例: 光回線の経験者を2名ご提案可能です。詳細を伺えますか。"></textarea>
              <button class="btn btn-primary w-full text-sm mt-2" id="board-inquire" onclick="__boardInquire(${p.post_id})"><i class="fas fa-paper-plane"></i>問い合わせる</button>
              <p class="text-[11px] text-gray-400 mt-2">やり取りは掲載企業と自社の間だけで行われ、他社には表示されません。スタッフ本人にも表示されません。</p>`
            : '<p class="text-xs text-gray-500">この掲載は募集を終了しています。</p>'}
          </section>
        </aside>
      </div>`
    if (p.is_mine) loadPostThreads(p.post_id)
  }
  async function loadPostThreads(postId) {
    const box = document.getElementById('board-post-threads'); if (!box) return
    try {
      const { data } = await axios.get('/api/admin/board/threads', { params: { post_id: postId } })
      box.innerHTML = data.threads.map(t => `
        <a href="#board/t${t.thread_id}" class="block p-2.5 rounded-lg bg-gray-50 hover:bg-blue-50 board-thread-item">
          <div class="flex items-center gap-2 text-xs">
            <span class="font-bold text-gray-800 truncate">${esc(t.partner_company_name)}</span>
            ${t.status === 'closed' ? '<span class="badge badge-gray">終了</span>' : ''}
            ${t.unread ? `<span class="badge badge-red ml-auto">${t.unread}</span>` : `<span class="ml-auto text-gray-400">${esc((t.last_message_at || '').slice(5, 16))}</span>`}
          </div>
          <p class="text-[11px] text-gray-500 truncate mt-0.5">${esc(t.last_body || '')}</p>
        </a>`).join('') || '<p class="text-xs text-gray-400">まだ問い合わせはありません</p>'
    } catch (e) { box.innerHTML = `<p class="text-xs text-red-500">${esc(errMsg(e))}</p>` }
  }
  window.__boardInquire = async function (postId) {
    const body = document.getElementById('board-first-msg').value.trim()
    if (!body) { toast('メッセージを入力してください'); return }
    try { const { data } = await axios.post(`/api/admin/board/posts/${postId}/threads`, { body }); toast('問い合わせを送信しました'); location.hash = '#board/t' + data.thread_id }
    catch (e) { toast(errMsg(e, '送信に失敗しました')) }
  }

  // ---------- やり取り一覧 ----------
  async function renderThreadList() {
    loading()
    let data
    try { data = (await axios.get('/api/admin/board/threads')).data } catch (e) { $app.innerHTML = `<div class="card p-6 text-sm text-red-500">${esc(errMsg(e))}</div>`; return }
    $app.innerHTML = `
      <div class="flex items-center gap-3 mb-4 flex-wrap">
        <a href="#board" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
        <h2 class="text-xl font-bold text-gray-900 flex-1"><i class="fas fa-comments text-blue-600 mr-1"></i>案件掲示板のやり取り</h2>
      </div>
      <section class="card p-0 overflow-x-auto" id="board-thread-list">
        <table class="tbl">
          <thead><tr><th>案件</th><th>相手企業</th><th>自社の立場</th><th>最新メッセージ</th><th>更新</th><th></th></tr></thead>
          <tbody>${data.threads.map(t => `
            <tr class="cursor-pointer" onclick="location.hash='#board/t${t.thread_id}'">
              <td><span class="badge ${ENG_BADGE[t.engagement_type]}">${ENG[t.engagement_type]}</span> <span class="font-bold text-gray-800">${esc(t.post_title)}</span>
                ${t.post_status !== 'open' ? `<span class="badge badge-gray">${STATUS[t.post_status] || ''}</span>` : ''}</td>
              <td class="text-sm">${esc(t.partner_company_name)}</td>
              <td>${t.my_side === 'poster' ? '<span class="badge badge-green">掲載企業</span>' : '<span class="badge badge-blue">問い合わせ</span>'}${t.status === 'closed' ? ' <span class="badge badge-gray">終了</span>' : ''}</td>
              <td class="text-xs text-gray-600 max-w-[320px] truncate">${esc(t.last_body || '—')}</td>
              <td class="text-xs text-gray-400 whitespace-nowrap">${esc((t.last_message_at || t.created_at || '').slice(5, 16))}</td>
              <td>${t.unread ? `<span class="badge badge-red">${t.unread}</span>` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="6" class="text-center text-gray-400 py-8">まだやり取りはありません（掲載中の案件の詳細から「問い合わせる」で開始できます）</td></tr>'}
          </tbody>
        </table>
      </section>`
    window.refreshBoardBadge()
  }

  // ---------- やり取り（スレッド） ----------
  let threadTimer = null
  async function renderThread(threadId) {
    loading()
    let data
    try { data = (await axios.get('/api/admin/board/threads/' + threadId)).data } catch (e) {
      $app.innerHTML = `<div class="card p-8 text-center text-sm text-gray-500">${esc(errMsg(e, 'やり取りが見つかりません'))}<br><a class="text-blue-600 underline" href="#board/threads">やり取り一覧に戻る</a></div>`; return
    }
    const t = data.thread
    $app.innerHTML = `
      <div class="flex items-center gap-3 mb-4 flex-wrap">
        <a href="#board/${t.post_id}" class="btn btn-outline" title="案件に戻る"><i class="fas fa-arrow-left"></i></a>
        <div class="flex-1 min-w-0">
          <div class="flex gap-2 mb-1 flex-wrap">
            <span class="badge ${ENG_BADGE[t.engagement_type]}">${ENG[t.engagement_type]}</span>
            ${t.my_side === 'poster' ? '<span class="badge badge-green">自社の掲載</span>' : '<span class="badge badge-blue">問い合わせ中</span>'}
            ${t.post_status !== 'open' ? `<span class="badge badge-gray">掲載: ${STATUS[t.post_status] || ''}</span>` : ''}
            ${t.status === 'closed' ? '<span class="badge badge-gray">やり取り終了</span>' : ''}
          </div>
          <h2 class="text-lg font-bold text-gray-900 truncate"><a class="hover:underline" href="#board/${t.post_id}">${esc(t.post_title)}</a></h2>
          <p class="text-sm text-gray-500">相手: <span class="font-bold text-gray-700">${esc(t.partner_company_name)}</span></p>
        </div>
        <button class="btn btn-outline text-sm" id="board-thread-toggle" onclick="__boardThreadStatus(${t.thread_id}, '${t.status === 'closed' ? 'open' : 'closed'}')">
          <i class="fas ${t.status === 'closed' ? 'fa-rotate-right' : 'fa-circle-xmark'}"></i>${t.status === 'closed' ? 'やり取りを再開' : 'やり取りを終了'}</button>
      </div>
      <section class="card p-4 max-w-4xl" id="board-thread">
        <p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2 mb-3"><i class="fas fa-eye-slash mr-1"></i>このやり取りは ${esc(t.poster_company_name)} と ${esc(t.inquirer_company_name)} の担当者のみ閲覧できます（他社・スタッフ本人には表示されません）</p>
        <div id="board-chat-log" class="space-y-2 max-h-[60vh] overflow-y-auto p-2 bg-gray-50 rounded-lg">${messagesHtml(data.messages)}</div>
        ${t.status === 'closed' ? '<p class="text-xs text-gray-500 text-center mt-3">このやり取りは終了しています。再開すると送信できます。</p>' : `
        <div class="flex gap-2 mt-3">
          <textarea id="board-chat-input" rows="3" maxlength="2000" class="inp text-sm flex-1" placeholder="メッセージを入力（Ctrl+Enterで送信）"></textarea>
          <button class="btn btn-primary self-end" id="board-chat-send" onclick="__boardSend(${t.thread_id})"><i class="fas fa-paper-plane"></i>送信</button>
        </div>
        <p class="text-[11px] text-gray-400 mt-1">人材の提案（スタッフマスタから選んでスキルシートを送る機能）は次の段階で追加されます。</p>`}
      </section>`
    const log = document.getElementById('board-chat-log'); log.scrollTop = log.scrollHeight
    const inp = document.getElementById('board-chat-input')
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.__boardSend(t.thread_id) } })
    window.refreshBoardBadge()
    // 開いている間は30秒ごとに新着を確認（画面全体は再描画しない）
    clearInterval(threadTimer)
    threadTimer = setInterval(() => {
      if (location.hash !== '#board/t' + threadId) { clearInterval(threadTimer); return }
      refreshThreadLog(threadId)
    }, 30 * 1000)
  }
  function messagesHtml(msgs) {
    return msgs.map(m => m.kind === 'system'
      ? `<div class="text-center"><span class="inline-block text-[11px] text-gray-500 bg-white border border-gray-200 rounded-full px-3 py-0.5">${esc(m.body)} ・ ${esc((m.created_at || '').slice(5, 16))}</span></div>`
      : `<div class="flex ${m.mine ? 'justify-end' : 'justify-start'}">
          <div class="max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.mine ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-800'}">
            <p class="text-[10px] ${m.mine ? 'text-blue-100' : 'text-gray-400'} mb-0.5">${esc(m.author_company_name)}${m.author_name ? ' ・ ' + esc(m.author_name) : ''} ・ ${esc((m.created_at || '').slice(5, 16))}</p>
            <p class="whitespace-pre-wrap break-words">${esc(m.body)}</p>
          </div>
        </div>`).join('') || '<p class="text-xs text-gray-400 text-center py-6">まだメッセージはありません</p>'
  }
  async function refreshThreadLog(threadId) {
    const log = document.getElementById('board-chat-log'); if (!log) return
    try {
      const { data } = await axios.get('/api/admin/board/threads/' + threadId)
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
      log.innerHTML = messagesHtml(data.messages)
      if (atBottom) log.scrollTop = log.scrollHeight
      window.refreshBoardBadge()
    } catch (e) { /* noop */ }
  }
  window.__boardSend = async function (threadId) {
    const el = document.getElementById('board-chat-input'); const body = el.value.trim()
    if (!body) return
    const btn = document.getElementById('board-chat-send'); btn.disabled = true
    try { await axios.post(`/api/admin/board/threads/${threadId}/messages`, { body }); el.value = ''; await refreshThreadLog(threadId); const log = document.getElementById('board-chat-log'); log.scrollTop = log.scrollHeight }
    catch (e) { toast(errMsg(e, '送信に失敗しました')) } finally { btn.disabled = false; el.focus() }
  }
  window.__boardThreadStatus = async function (threadId, status) {
    if (status === 'closed' && !confirm('このやり取りを終了しますか？（履歴は残り、あとで再開できます）')) return
    try { await axios.post(`/api/admin/board/threads/${threadId}/status`, { status }); toast(status === 'closed' ? 'やり取りを終了しました' : 'やり取りを再開しました'); renderThread(threadId) }
    catch (e) { toast(errMsg(e)) }
  }

  // ---------- 未読バッジ（サイドバー / モバイルメニュー / 一覧のボタン） ----------
  window.refreshBoardBadge = async function () {
    let n = 0
    try { n = (await axios.get('/api/admin/board/unread-count')).data.unread } catch { return }
    const el = document.getElementById('board-badge'); if (el) { el.textContent = n; el.classList.toggle('hidden', !n) }
    const opt = document.querySelector('#mobile-nav option[value="board"]'); if (opt) opt.textContent = '案件掲示板' + (n ? `（${n}）` : '')
    document.querySelectorAll('.board-unread-total').forEach(b => { b.textContent = n; b.classList.toggle('hidden', !n) })
  }
  setInterval(() => window.refreshBoardBadge(), 60 * 1000)
  setTimeout(() => window.refreshBoardBadge(), 900)

  window.__boardStatus = async function (id, status) {
    const msg = { open: 'この案件を掲載しますか？掲載内容と自社名が全利用企業に公開されます。', closed: 'この掲載を締め切りますか？一覧に表示されなくなります。', filled: '充足（募集終了）にしますか？一覧に表示されなくなります。' }[status]
    if (msg && !confirm(msg)) return
    try { await axios.post(`/api/admin/board/posts/${id}/status`, { status }); toast({ open: '掲載しました', closed: '締め切りました', filled: '充足にしました' }[status] || '更新しました'); renderDetail(id) }
    catch (e) { toast(errMsg(e, '更新に失敗しました')) }
  }
  window.__boardDelete = async function (id) {
    if (!confirm('この下書きを削除しますか？')) return
    try { await axios.delete('/api/admin/board/posts/' + id); toast('削除しました'); S.scope = 'mine'; location.hash = '#board' }
    catch (e) { toast(errMsg(e, '削除に失敗しました')) }
  }
  window.__boardDuplicate = function (id) { S.duplicateFrom = id; location.hash = '#board/new' }

  // ---------- 作成・編集 ----------
  async function renderForm(id) {
    loading()
    let p = { engagement_type: S.eng || 'regular', headcount: 1, price_unit: 'daily', status: 'draft' }
    try {
      if (id) {
        p = (await axios.get('/api/admin/board/posts/' + id)).data.post
        if (!p.is_mine) { location.hash = '#board/' + id; return }
      } else if (S.duplicateFrom) {
        const src = (await axios.get('/api/admin/board/posts/' + S.duplicateFrom)).data.post
        p = { ...src, post_id: null, status: 'draft', deadline: '', title: src.title + '（コピー）' }
      }
    } catch (e) { toast(errMsg(e)); location.hash = '#board'; return } finally { S.duplicateFrom = null }
    if (!projectsCache) { try { projectsCache = (await axios.get('/api/admin/projects')).data.projects || [] } catch { projectsCache = [] } }
    const v = (k) => esc(p[k] == null ? '' : p[k])
    const lab = (t, req) => `<label class="text-xs text-gray-600 block mb-1">${t}${req ? ' <span class="text-red-500">*</span>' : ''}</label>`
    $app.innerHTML = `
      <div class="flex items-center gap-3 mb-4">
        <a href="${id ? '#board/' + id : '#board'}" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
        <h2 class="text-xl font-bold text-gray-900 flex-1">${id ? '掲載の編集' : '案件を掲載'}</h2>
      </div>
      <section class="card p-5 max-w-4xl" id="board-form">
        ${id ? '' : `
        <div class="bg-gray-50 rounded-lg p-3 mb-4 flex gap-2 items-center flex-wrap">
          <span class="text-xs text-gray-600"><i class="fas fa-copy mr-1"></i>自社の案件から内容をコピー</span>
          <select id="bp-copy-src" class="inp text-xs w-auto flex-1 min-w-[200px]"><option value="">案件を選択</option>
            ${projectsCache.map(x => `<option value="${x.project_id}">${esc(x.project_name)}${x.client_name ? '（' + esc(x.client_name) + '）' : ''}</option>`).join('')}</select>
          <button class="btn btn-outline text-xs" onclick="__boardCopyProject()">反映</button>
          <p class="text-[11px] text-gray-400 w-full">クライアント名は掲載されません。コピー後に、公開してよい内容か確認してください。</p>
        </div>`}
        <input type="hidden" id="bp-source-project" value="${v('source_project_id')}">
        <div class="grid md:grid-cols-2 gap-4">
          <div class="md:col-span-2">${lab('区分', true)}
            <div class="flex gap-2" id="bp-eng">${['regular', 'spot'].map(k => `<label class="btn ${p.engagement_type === k ? 'btn-primary' : 'btn-outline'} text-sm cursor-pointer">
              <input type="radio" name="bp-eng" value="${k}" class="hidden" ${p.engagement_type === k ? 'checked' : ''} onchange="__boardEngChanged()">${ENG[k]}</label>`).join('')}</div></div>
          <div class="md:col-span-2">${lab('案件名', true)}<input id="bp-title" class="inp" maxlength="100" value="${v('title')}" placeholder="例: 家電量販店での光回線獲得スタッフ"></div>
          <div>${lab('都道府県', true)}<select id="bp-pref" class="inp"><option value="">選択</option>${PREFS.map(x => `<option ${p.prefecture === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          <div>${lab('エリア（市区町村など）')}<input id="bp-area" class="inp" maxlength="100" value="${v('area')}" placeholder="例: 新宿区・渋谷区"></div>
          <div>${lab('最寄駅')}<input id="bp-station" class="inp" maxlength="100" value="${v('nearest_station')}" placeholder="例: 新宿駅"></div>
          <div>${lab('募集人数', true)}<input id="bp-headcount" type="number" min="1" max="999" class="inp" value="${v('headcount')}"></div>
          <div><span id="bp-date-from-label">${lab(p.engagement_type === 'spot' ? '実施日（開始）' : '開始日', true)}</span><input id="bp-date-from" type="date" class="inp" value="${v('date_from')}"></div>
          <div><span id="bp-date-to-label">${lab(p.engagement_type === 'spot' ? '実施日（終了・複数日の場合）' : '終了予定日（空欄＝長期）')}</span><input id="bp-date-to" type="date" class="inp" value="${v('date_to')}"></div>
          <div>${lab('時間帯', p.engagement_type === 'spot')}<div class="flex items-center gap-2"><input id="bp-time-from" type="time" class="inp" value="${v('time_from')}"><span>〜</span><input id="bp-time-to" type="time" class="inp" value="${v('time_to')}"></div></div>
          <div>${lab('勤務条件')}<input id="bp-schedule-note" class="inp" maxlength="200" value="${v('schedule_note')}" placeholder="例: 週5・土日含む／シフト制"></div>
          <div class="md:col-span-2 border-t pt-4">${lab('単価', true)}
            <div class="grid grid-cols-12 gap-2 items-center">
              <select id="bp-price-unit" class="inp col-span-3 md:col-span-2">${Object.entries(UNIT).map(([k, l]) => `<option value="${k}" ${p.price_unit === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <div class="col-span-9 md:col-span-3 flex items-center gap-1"><input id="bp-price" type="number" min="1" class="inp" value="${v('price_amount')}" placeholder="金額"><span class="text-sm shrink-0">円</span></div>
              <input id="bp-price-note" class="inp col-span-12 md:col-span-7" maxlength="100" list="bp-price-notes" value="${v('price_note')}" placeholder="単価の備考（例: スキルにより交渉可能）">
              <datalist id="bp-price-notes">${PRICE_NOTES.map(x => `<option value="${x}">`).join('')}</datalist>
            </div>
            <div class="flex gap-1 mt-2 flex-wrap">${PRICE_NOTES.map(x => `<button type="button" class="text-[11px] py-0.5 px-2 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50" onclick="__boardNote('${x}')">+ ${x}</button>`).join('')}</div>
            <p class="text-[11px] text-gray-400 mt-1">単価は必須です。「応相談」などは備考に記入してください。</p></div>
          <div class="md:col-span-2">${lab('求めるスキル（カンマ区切り）')}<input id="bp-skills" class="inp" value="${v('required_skills')}" placeholder="例: MNP,光回線,クロージング"></div>
          <div class="md:col-span-2">${lab('業務内容・詳細')}<textarea id="bp-desc" rows="8" class="inp" maxlength="4000" placeholder="業務内容、服装、持ち物、求める経験など">${v('description')}</textarea></div>
          <div>${lab('締切日')}<input id="bp-deadline" type="date" class="inp" value="${v('deadline')}"><p class="text-[11px] text-gray-400 mt-1">締切日を過ぎると自動で「締切」になります</p></div>
        </div>
        <div class="flex gap-2 justify-end mt-5 pt-4 border-t flex-wrap">
          <a class="btn btn-outline" href="${id ? '#board/' + id : '#board'}">キャンセル</a>
          ${!id || p.status === 'draft' ? `<button class="btn btn-outline" id="bp-save-draft" onclick="__boardSave(${id || 'null'}, 'draft')"><i class="fas fa-floppy-disk"></i>下書き保存</button>` : ''}
          <button class="btn btn-primary" id="bp-save-open" onclick="__boardSave(${id || 'null'}, 'open')"><i class="fas fa-paper-plane"></i>${id && p.status === 'open' ? '保存（掲載中）' : '掲載する'}</button>
        </div>
      </section>`
  }
  window.__boardEngChanged = function () {
    const eng = document.querySelector('input[name=bp-eng]:checked').value
    document.querySelectorAll('#bp-eng label').forEach(l => { const on = l.querySelector('input').checked; l.classList.toggle('btn-primary', on); l.classList.toggle('btn-outline', !on) })
    document.getElementById('bp-date-from-label').innerHTML = `<label class="text-xs text-gray-600 block mb-1">${eng === 'spot' ? '実施日（開始）' : '開始日'} <span class="text-red-500">*</span></label>`
    document.getElementById('bp-date-to-label').innerHTML = `<label class="text-xs text-gray-600 block mb-1">${eng === 'spot' ? '実施日（終了・複数日の場合）' : '終了予定日（空欄＝長期）'}</label>`
  }
  window.__boardNote = function (t) {
    const el = document.getElementById('bp-price-note')
    const cur = el.value.trim()
    el.value = !cur ? t : cur.includes(t) ? cur : cur + '・' + t
  }
  window.__boardCopyProject = async function () {
    const pid = document.getElementById('bp-copy-src').value
    if (!pid) { toast('案件を選択してください'); return }
    try {
      const t = (await axios.get('/api/admin/board/project-template/' + pid)).data.template
      const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null && val !== '') el.value = val }
      set('bp-title', t.title); set('bp-area', t.area); set('bp-skills', t.required_skills); set('bp-desc', t.description)
      set('bp-price', t.price_amount); set('bp-price-unit', t.price_unit)
      document.getElementById('bp-source-project').value = t.source_project_id
      const r = document.querySelector(`input[name=bp-eng][value=${t.engagement_type}]`); if (r) { r.checked = true; window.__boardEngChanged() }
      toast('案件の内容を反映しました。公開してよい内容か確認してください')
    } catch (e) { toast(errMsg(e)) }
  }
  window.__boardSave = async function (id, status) {
    const g = (k) => document.getElementById(k).value
    const body = {
      engagement_type: (document.querySelector('input[name=bp-eng]:checked') || {}).value,
      title: g('bp-title'), prefecture: g('bp-pref'), area: g('bp-area'), nearest_station: g('bp-station'),
      headcount: Number(g('bp-headcount') || 0), date_from: g('bp-date-from'), date_to: g('bp-date-to'),
      time_from: g('bp-time-from'), time_to: g('bp-time-to'), schedule_note: g('bp-schedule-note'),
      price_unit: g('bp-price-unit'), price_amount: g('bp-price') === '' ? null : Number(g('bp-price')), price_note: g('bp-price-note'),
      required_skills: g('bp-skills'), description: g('bp-desc'), deadline: g('bp-deadline'), source_project_id: g('bp-source-project') || null, status,
    }
    if (status === 'open' && !(id && document.getElementById('bp-save-draft') === null) && !confirm('この内容で掲載しますか？掲載内容と自社名が全利用企業に公開されます。')) return
    try {
      if (id) { await axios.put('/api/admin/board/posts/' + id, body); toast('保存しました'); location.hash = '#board/' + id }
      else { const { data } = await axios.post('/api/admin/board/posts', body); toast(status === 'open' ? '掲載しました' : '下書きを保存しました'); location.hash = '#board/' + data.post_id }
    } catch (e) { toast(errMsg(e, '保存に失敗しました')) }
  }
})()
