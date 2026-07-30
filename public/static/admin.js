// Field OS 管理者用SPA
const $app = document.getElementById('app')
let ME = null

const LABELS = { mnp: 'MNP', pi: 'PI', shinki: '新規', kishuhen: '機変', hikari: '光回線', wifi: 'Wi-Fi', denki: 'でんき', card: 'クレカ', koekake: '声かけ', shodan: '商談', seiyaku: '成約' }
const CAT_LABELS = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
const FOLLOW_LABELS = { interview: '面談', phone: '電話', line: 'LINE連絡', warning: '注意', praise: '称賛', training: '研修案内', claim: 'クレーム対応', health: '体調確認', shift: '稼働相談', career: 'キャリア相談', round: 'ラウンド' }
const PTYPE_LABELS = { mobile_shop: '携帯ショップ', electronics: '家電量販店', event: '催事・イベント', fiber: '光回線', fixed_line: '固定回線', callcenter: 'コールセンター', other: 'その他' }
const RISK_BADGE = { low: '<span class="badge badge-green">低</span>', mid: '<span class="badge badge-yellow">中</span>', high: '<span class="badge badge-red">高</span>' }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) }
function yen(n) { return '¥' + Number(n || 0).toLocaleString() }
function toast(msg) {
  let root = document.getElementById('toast')
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
  const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg
  root.appendChild(el); setTimeout(() => el.remove(), 2500)
}
function loading() { $app.innerHTML = '<div class="flex justify-center py-20"><span class="spin"></span></div>' }
function modal(html) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-box p-5">${html}</div></div>`
}
window.closeModal = () => { document.getElementById('modal-root').innerHTML = '' }

axios.interceptors.response.use(r => r, e => {
  if (e.response && e.response.status === 401) location.href = '/login'
  return Promise.reject(e)
})

document.getElementById('logout-btn').addEventListener('click', async () => {
  await axios.post('/api/auth/logout'); location.href = '/login'
})

// ============ ダッシュボード ============
window.togglePhotoRequired = async function (enabled) {
  try {
    await axios.post('/api/admin/settings/photo-required', { enabled })
    toast(enabled ? '写真添付を必須にしました' : '写真添付を無効にしました')
    renderDashboard()
  } catch {
    toast('設定の更新に失敗しました')
  }
}

async function renderDashboard() {
  loading()
  const { data } = await axios.get('/api/admin/dashboard')
  const un = data.unreported
  const kpi = (label, value, icon, color, sub) => `
    <div class="card p-4 min-w-0">
      <div class="flex items-center justify-between">
        <div class="min-w-0">
          <p class="text-xs text-gray-500">${label}</p>
          <p class="text-2xl font-bold text-gray-900 mt-0.5 truncate">${value}</p>
          ${sub ? `<p class="text-xs text-gray-400 mt-0.5">${sub}</p>` : ''}
        </div>
        <span class="w-10 h-10 rounded-xl ${color} flex items-center justify-center"><i class="fas ${icon}"></i></span>
      </div>
    </div>`

  const alertList = (title, list, color) => `
    <div class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">${title}
        <span class="badge ${list.length ? 'badge-' + color : 'badge-green'} ml-1">${list.length ? list.length + '名' : 'なし'}</span></h3>
      ${list.length ? `<div class="flex flex-wrap gap-1.5">${list.map(s => `<a href="#staff/${s.staff_id}" class="badge badge-${color} hover:opacity-80">${esc(s.name)}</a>`).join('')}</div>`
      : '<p class="text-xs text-gray-400">全員報告済みです <i class="fas fa-check text-emerald-500"></i></p>'}
    </div>`

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h2 class="text-xl font-bold text-gray-900">管理者ダッシュボード</h2>
        <p class="text-sm text-gray-500">${dayjs(data.today).format('YYYY年M月D日')} — 今日見るべきこと・対応すべきこと</p>
      </div>
      <button class="btn btn-outline" onclick="renderDashboard()"><i class="fas fa-rotate"></i>更新</button>
    </div>

    <div class="card p-4 mb-5 flex items-center justify-between flex-wrap gap-3">
      <div>
        <p class="font-bold text-gray-800 text-sm"><i class="fas fa-camera text-blue-600 mr-1"></i>入店/退店報告の写真添付</p>
        <p class="text-xs text-gray-400 mt-0.5">無効にすると写真添付欄は表示されず、スタッフはボタンひとつで報告できます</p>
      </div>
      <button class="btn ${data.photo_required_attendance ? 'btn-primary' : 'btn-outline'}" onclick="togglePhotoRequired(${!data.photo_required_attendance})">
        <i class="fas ${data.photo_required_attendance ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>${data.photo_required_attendance ? '有効' : '無効'}
      </button>
    </div>

    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5" id="kpi-cards">
      ${kpi('本日の稼働予定', data.working_count + '名', 'fa-users', 'bg-blue-100 text-blue-600')}
      ${kpi('本日の売上予定', yen(data.revenue_forecast), 'fa-yen-sign', 'bg-emerald-100 text-emerald-600')}
      ${kpi('日報未提出（直近3日）', data.missing_daily_reports.length + '件', 'fa-file-circle-exclamation', data.missing_daily_reports.length ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-400')}
      ${kpi('要フォロースタッフ', data.follow_staff.length + '名', 'fa-hand-holding-heart', data.follow_staff.length ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-400')}
    </section>

    <section class="grid md:grid-cols-3 gap-4 mb-5" id="unreported-section">
      ${alertList('<i class="fas fa-sun text-amber-500 mr-1"></i>未起床報告', un.wake_up, 'red')}
      ${alertList('<i class="fas fa-person-walking-luggage text-blue-500 mr-1"></i>未出発報告', un.departure, 'yellow')}
      ${alertList('<i class="fas fa-store text-purple-500 mr-1"></i>未入店報告', un.check_in, 'yellow')}
    </section>

    <div class="grid lg:grid-cols-2 gap-4 mb-5">
      <section class="card p-4" id="todo-section">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-list-check text-blue-600 mr-1"></i>管理者ToDo（運営支援）</h3>
        <div class="space-y-2 max-h-80 overflow-y-auto">
          ${data.todos.map(t => `
            <div class="flex items-start gap-2.5 p-2.5 rounded-lg ${t.level === 'high' ? 'bg-red-50' : 'bg-amber-50'}">
              <i class="fas ${t.level === 'high' ? 'fa-circle-exclamation text-red-500' : 'fa-triangle-exclamation text-amber-500'} mt-0.5"></i>
              <p class="text-sm ${t.level === 'high' ? 'text-red-800' : 'text-amber-800'} flex-1">${esc(t.text)}</p>
              ${t.staff_id ? `<a href="#staff/${t.staff_id}" class="text-xs text-blue-600 whitespace-nowrap hover:underline">詳細→</a>` : ''}
            </div>`).join('') || '<p class="text-sm text-gray-400 py-4 text-center">対応すべきタスクはありません <i class="fas fa-check text-emerald-500"></i></p>'}
        </div>
      </section>

      <section class="card p-4" id="incident-section">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-bolt text-red-500 mr-1"></i>インシデント・クレーム（直近7日）</h3>
        <div class="space-y-2 max-h-80 overflow-y-auto">
          ${data.incidents.map(i => `
            <div class="p-2.5 rounded-lg bg-gray-50 border border-gray-100">
              <div class="flex items-center gap-2 text-xs mb-1">
                ${i.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
                ${i.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
                <span class="text-gray-500">${dayjs(i.work_date).format('M/D')}</span>
                <a href="#staff/${i.staff_id}" class="text-blue-600 hover:underline">${esc(i.staff_name)}</a>
                <span class="text-gray-400">${esc(i.project_name)}</span>
              </div>
              <p class="text-xs text-gray-600">${esc((i.values && i.values.free) || '')}</p>
            </div>`).join('') || '<p class="text-sm text-gray-400 py-4 text-center">直近のインシデントはありません</p>'}
        </div>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-5">
      <section class="card p-4">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-hand-holding-heart text-amber-500 mr-1"></i>要フォロースタッフ</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>氏名</th><th>離職リスク</th><th>評価</th><th>メモ</th><th></th></tr></thead>
          <tbody>
            ${data.follow_staff.map(s => `
              <tr>
                <td class="font-medium">${esc(s.name)}</td>
                <td>${RISK_BADGE[s.retention_risk] || ''}</td>
                <td>${Number(s.evaluation_score).toFixed(1)}</td>
                <td class="text-xs text-gray-500 max-w-[180px] truncate">${esc(s.memo || '')}</td>
                <td><a href="#staff/${s.staff_id}" class="text-blue-600 text-xs hover:underline">詳細</a></td>
              </tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400 py-4">要フォロースタッフはいません</td></tr>'}
          </tbody>
        </table>
        </div>
      </section>

      <section class="card p-4">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-briefcase text-blue-600 mr-1"></i>今月の案件別実績</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>案件</th><th>日報</th><th>MNP</th><th>PI</th><th>新規</th><th>光</th><th>成約</th></tr></thead>
          <tbody>
            ${data.project_performance.map(p => `
              <tr>
                <td><a href="#projects/${p.project_id}" class="text-blue-600 hover:underline font-medium">${esc(p.project_name)}</a></td>
                <td>${p.report_count}</td><td>${p.mnp || 0}</td><td>${p.pi || 0}</td><td>${p.shinki || 0}</td><td>${p.hikari || 0}</td>
                <td class="font-bold">${p.seiyaku || 0}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </section>
    </div>

    <section class="card p-4" id="today-shifts">
      <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-calendar-day text-blue-600 mr-1"></i>本日のシフト・報告状況</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>スタッフ</th><th>案件</th><th>時間</th><th>起床</th><th>出発</th><th>入店</th><th>退店</th><th>操作</th></tr></thead>
          <tbody>
            ${data.shifts.map(s => {
              const mark = v => v ? '<i class="fas fa-circle-check text-emerald-500"></i>' : '<i class="fas fa-circle-xmark text-red-400"></i>'
              return `<tr>
                <td><a href="#staff/${s.staff_id}" class="text-blue-600 hover:underline font-medium">${esc(s.staff_name)}</a></td>
                <td class="text-xs">${esc(s.project_name)}</td>
                <td class="text-xs">${s.start_time}〜${s.end_time}</td>
                <td class="text-center">${mark(s.wake_up)}</td><td class="text-center">${mark(s.departure)}</td>
                <td class="text-center">${mark(s.check_in)}</td><td class="text-center">${mark(s.check_out)}</td>
                <td>
                  <button class="text-xs text-red-600 hover:underline" onclick="markAbsent(${s.shift_id})">欠勤にする</button>
                </td>
              </tr>`
            }).join('') || '<tr><td colspan="8" class="text-center text-gray-400 py-4">本日のシフトはありません</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>`
}

window.markAbsent = async function (shiftId) {
  if (!confirm('このシフトを欠勤に変更しますか？')) return
  await axios.put('/api/admin/shifts/' + shiftId, { status: 'absent' })
  toast('欠勤として登録しました')
  renderDashboard()
}

// ============ スタッフ一覧 ============
let staffCache = []
async function renderStaff() {
  loading()
  const { data } = await axios.get('/api/admin/staff')
  staffCache = data.staff
  drawStaffTable('all')
}

function drawStaffTable(filter) {
  let list = staffCache
  if (filter === 'follow') list = list.filter(s => s.follow_flag)
  if (filter === 'risk') list = list.filter(s => s.retention_risk !== 'low')
  if (filter === 'noreport') list = list.filter(s => s.today_shift && !s.today_checkin)
  if (filter === 'lowscore') list = list.filter(s => s.evaluation_score < 3)

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">スタッフ管理 <span class="text-sm font-normal text-gray-400">${list.length}名</span></h2>
      <button class="btn btn-primary" onclick="showAddStaff()"><i class="fas fa-user-plus"></i>スタッフ登録</button>
    </div>
    <div class="flex gap-2 mb-4 flex-wrap" id="staff-filters">
      ${[['all', 'すべて'], ['follow', '要フォロー'], ['risk', '離職リスク'], ['noreport', '本日未入店'], ['lowscore', '評価3未満']].map(([k, v]) =>
        `<button class="btn ${filter === k ? 'btn-primary' : 'btn-outline'}" onclick="drawStaffTable('${k}')">${v}</button>`).join('')}
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>番号</th><th>氏名</th><th>所属案件</th><th>今月稼働</th><th>今月成約</th><th>評価</th><th>離職リスク</th><th>要フォロー</th><th>最終稼働</th><th>最終日報</th></tr></thead>
        <tbody>
          ${list.map(s => `
            <tr class="cursor-pointer" onclick="location.hash='staff/${s.staff_id}'">
              <td class="text-gray-400">${esc(s.user_code)}</td>
              <td class="font-medium text-blue-700">${esc(s.name)}</td>
              <td class="text-xs max-w-[200px] truncate">${esc(s.projects || '-')}</td>
              <td>${s.month_days}日</td>
              <td class="font-bold">${s.month_seiyaku || 0}</td>
              <td>${Number(s.evaluation_score).toFixed(1)}</td>
              <td>${RISK_BADGE[s.retention_risk] || ''}</td>
              <td>${s.follow_flag ? '<span class="badge badge-red">要フォロー</span>' : '<span class="text-gray-300">-</span>'}</td>
              <td class="text-xs text-gray-500">${s.last_work_date ? dayjs(s.last_work_date).format('M/D') : '-'}</td>
              <td class="text-xs text-gray-500">${s.last_report_date ? dayjs(s.last_report_date).format('M/D') : '-'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`
}
window.drawStaffTable = drawStaffTable

window.showAddStaff = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4">スタッフ登録</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">スタッフ番号 *</label><input id="ns-code" class="inp" placeholder="st021"></div>
        <div><label class="text-sm text-gray-600 block mb-1">氏名 *</label><input id="ns-name" class="inp" placeholder="山田 太郎"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">初期パスワード *</label><input id="ns-pass" class="inp" value="pass1234"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">メール</label><input id="ns-email" class="inp"></div>
        <div><label class="text-sm text-gray-600 block mb-1">電話</label><input id="ns-phone" class="inp"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">スキル（カンマ区切り）</label><input id="ns-skills" class="inp" placeholder="MNP,接客"></div>
      <div><label class="text-sm text-gray-600 block mb-1">経歴</label><input id="ns-career" class="inp"></div>
      <div><label class="text-sm text-gray-600 block mb-1">稼働可能エリア</label><input id="ns-area" class="inp" placeholder="東京23区"></div>
      <button class="btn btn-primary w-full" onclick="addStaff()">登録する</button>
    </div>`)
}

window.addStaff = async function () {
  try {
    await axios.post('/api/admin/staff', {
      user_code: document.getElementById('ns-code').value.trim(),
      name: document.getElementById('ns-name').value.trim(),
      password: document.getElementById('ns-pass').value,
      email: document.getElementById('ns-email').value, phone: document.getElementById('ns-phone').value,
      skills: document.getElementById('ns-skills').value, career: document.getElementById('ns-career').value,
      work_area: document.getElementById('ns-area').value
    })
    closeModal(); toast('スタッフを登録しました'); renderStaff()
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '登録に失敗しました') }
}

// ============ スタッフ詳細 ============
async function renderStaffDetail(sid) {
  loading()
  const { data } = await axios.get('/api/admin/staff/' + sid)
  const p = data.profile
  const evalRadar = data.evaluations[0]

  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <a href="#staff" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold text-gray-900">${esc(p.name)} <span class="text-sm text-gray-400 font-normal">${esc(p.user_code)}</span></h2>
        <div class="flex gap-2 mt-1">
          ${RISK_BADGE[p.retention_risk]}
          ${p.follow_flag ? '<span class="badge badge-red">要フォロー</span>' : ''}
          <span class="badge badge-blue">評価 ${Number(p.evaluation_score).toFixed(1)}</span>
        </div>
      </div>
      <button class="btn btn-outline" onclick="showSkillSheet(${sid})"><i class="fas fa-file-export"></i>スキルシート作成</button>
      <button class="btn btn-primary" onclick="showFollowModal(${sid}, '${esc(p.name)}')"><i class="fas fa-plus"></i>フォロー記録</button>
    </div>

    <div class="grid lg:grid-cols-3 gap-4 mb-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">基本情報</h3>
        <dl class="text-sm space-y-2">
          <div class="flex"><dt class="w-24 text-gray-400">所属</dt><dd>${esc(p.affiliation || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400">年代</dt><dd>${esc(p.age_group || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400">エリア</dt><dd>${esc(p.work_area || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400">スキル</dt><dd class="flex flex-wrap gap-1">${(p.skills || '').split(',').filter(Boolean).map(s => `<span class="badge badge-blue">${esc(s)}</span>`).join('') || '-'}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400">連絡先</dt><dd class="text-xs">${esc(p.phone || '')}<br>${esc(p.email || '')}</dd></div>
          <div><dt class="text-gray-400 mb-1">経歴</dt><dd class="text-xs text-gray-600">${esc(p.career || '-')}</dd></div>
        </dl>
        <div class="mt-3 pt-3 border-t border-gray-100">
          <label class="text-xs text-gray-400 block mb-1">管理者メモ</label>
          <textarea id="staff-memo" rows="2" class="inp text-xs">${esc(p.memo || '')}</textarea>
          <div class="flex gap-2 mt-2">
            <button class="btn btn-outline flex-1 text-xs" onclick="saveStaffMemo(${sid})">メモ保存</button>
            <button class="btn ${p.follow_flag ? 'btn-danger' : 'btn-outline'} flex-1 text-xs" onclick="toggleFollow(${sid}, ${p.follow_flag ? 0 : 1})">
              ${p.follow_flag ? 'フォロー解除' : '要フォロー登録'}</button>
          </div>
        </div>
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">評価（${evalRadar ? esc(evalRadar.evaluation_period) : '-'}）</h3>
        ${evalRadar ? `<canvas id="eval-chart" height="220"></canvas>` : '<p class="text-sm text-gray-400">評価データがありません</p>'}
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">月次実績推移</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>月</th><th>日数</th><th>MNP</th><th>PI</th><th>新規</th><th>光</th><th>成約</th></tr></thead>
          <tbody>${data.performance.map(m => `
            <tr><td>${esc(m.ym)}</td><td>${m.days}</td><td>${m.mnp}</td><td>${m.pi}</td><td>${m.shinki}</td><td>${m.hikari}</td><td class="font-bold">${m.seiyaku}</td></tr>`).join('') || '<tr><td colspan="7" class="text-gray-400 text-center py-3">データなし</td></tr>'}
          </tbody>
        </table>
        </div>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-handshake-angle text-amber-500 mr-1"></i>フォロー履歴</h3>
        <div class="space-y-2 max-h-72 overflow-y-auto">
          ${data.follow_logs.map(f => `
            <div class="p-2.5 rounded-lg bg-gray-50">
              <div class="flex items-center gap-2 text-xs mb-1">
                <span class="badge badge-purple">${FOLLOW_LABELS[f.follow_type] || f.follow_type}</span>
                <span class="text-gray-400">${dayjs(f.created_at).format('M/D HH:mm')}</span>
                <span class="text-gray-500">${esc(f.manager_name || '')}</span>
                ${f.status === 'open' ? '<span class="badge badge-yellow">対応中</span>' : '<span class="badge badge-green">完了</span>'}
              </div>
              <p class="text-xs text-gray-700">${esc(f.content)}</p>
              ${f.next_action ? `<p class="text-xs text-blue-700 mt-1"><i class="fas fa-arrow-right mr-1"></i>${esc(f.next_action)}</p>` : ''}
            </div>`).join('') || '<p class="text-sm text-gray-400">フォロー履歴はありません</p>'}
        </div>
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-file-lines text-blue-500 mr-1"></i>日報履歴</h3>
        <div class="space-y-2 max-h-72 overflow-y-auto">
          ${data.reports.map(r => `
            <div class="p-2.5 rounded-lg bg-gray-50">
              <div class="flex items-center gap-2 text-xs mb-1">
                <span class="font-bold text-gray-700">${dayjs(r.work_date).format('M/D')}</span>
                <span class="text-gray-400">${esc(r.project_name)}</span>
                ${r.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
                ${r.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
              </div>
              <div class="flex flex-wrap gap-1">
                ${Object.entries(r.values).filter(([k, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `<span class="badge badge-gray">${LABELS[k] || k} ${v}</span>`).join('')}
              </div>
              ${r.values.free ? `<p class="text-xs text-gray-500 mt-1">${esc(r.values.free)}</p>` : ''}
            </div>`).join('') || '<p class="text-sm text-gray-400">日報履歴はありません</p>'}
        </div>
      </section>
    </div>

    <section class="card p-4 mt-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-clock text-gray-400 mr-1"></i>勤怠報告履歴（直近）</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>稼働日</th><th>種別</th><th>報告時刻</th><th>状態</th><th>位置情報</th></tr></thead>
          <tbody>${data.attendance.slice(0, 20).map(a => {
            const RL = { wake_up: '起床', departure: '出発', check_in: '入店', check_out: '退店' }
            return `<tr>
              <td>${dayjs(a.work_date).format('M/D')}</td>
              <td>${RL[a.report_type] || a.report_type}</td>
              <td>${dayjs(a.reported_at).format('HH:mm')}</td>
              <td>${a.status === 'late' ? '<span class="badge badge-red">遅延</span>' : a.status === 'no_location' ? '<span class="badge badge-yellow">位置不明</span>' : '<span class="badge badge-green">正常</span>'}</td>
              <td class="text-xs text-gray-400">${a.latitude ? Number(a.latitude).toFixed(4) + ', ' + Number(a.longitude).toFixed(4) : '-'}</td>
            </tr>`}).join('')}
          </tbody>
        </table>
      </div>
    </section>`

  if (evalRadar) {
    new Chart(document.getElementById('eval-chart'), {
      type: 'radar',
      data: {
        labels: ['勤怠安定性', '報告正確性', '実績', 'クライアント評価', '成長意欲', '継続見込み'],
        datasets: [{
          data: [evalRadar.attendance_score, evalRadar.report_score, evalRadar.performance_score, evalRadar.client_score, evalRadar.growth_score, evalRadar.retention_score],
          backgroundColor: 'rgba(37,99,235,.15)', borderColor: '#2563eb', pointBackgroundColor: '#2563eb'
        }]
      },
      options: { scales: { r: { min: 0, max: 5, ticks: { stepSize: 1 } } }, plugins: { legend: { display: false } } }
    })
  }
}

window.saveStaffMemo = async function (sid) {
  await axios.put('/api/admin/staff/' + sid, { memo: document.getElementById('staff-memo').value })
  toast('メモを保存しました')
}
window.toggleFollow = async function (sid, flag) {
  await axios.put('/api/admin/staff/' + sid, { follow_flag: flag })
  toast(flag ? '要フォローに登録しました' : 'フォローを解除しました')
  renderStaffDetail(sid)
}

window.showSkillSheet = async function (sid) {
  const { data } = await axios.get('/api/admin/staff/' + sid + '/skill-sheet')
  const p = data.profile, perf = data.performance, ev = data.evaluation
  modal(`
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h3 class="font-bold text-lg"><i class="fas fa-file-lines text-blue-600 mr-1"></i>スキルシート</h3>
      <button class="btn btn-outline text-xs" onclick="window.print()"><i class="fas fa-print"></i>印刷</button>
    </div>
    <div class="border border-gray-200 rounded-xl p-4 text-sm space-y-3">
      <div class="border-b pb-2"><p class="text-lg font-bold">${esc(p.name)}</p><p class="text-xs text-gray-500">${esc(p.age_group || '')} ｜ 稼働可能エリア: ${esc(p.work_area || '-')}</p></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">経歴</p><p>${esc(p.career || '-')}</p></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">経験案件</p>
        <div class="flex flex-wrap gap-1">${data.experienced_projects.map(pr => `<span class="badge badge-blue">${esc(pr.project_name)}</span>`).join('') || '-'}</div></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">保有スキル</p>
        <div class="flex flex-wrap gap-1">${(p.skills || '').split(',').filter(Boolean).map(s => `<span class="badge badge-purple">${esc(s)}</span>`).join('') || '-'}</div></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">通算実績（${perf.total_days || 0}稼働日）</p>
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
          ${[['MNP', perf.mnp], ['PI', perf.pi], ['新規', perf.shinki], ['光回線', perf.hikari], ['成約', perf.seiyaku]].map(([l, v]) =>
            `<div class="bg-gray-50 rounded-lg py-2"><p class="font-bold text-blue-600">${v || 0}</p><p class="text-xs text-gray-500">${l}</p></div>`).join('')}
        </div></div>
      ${ev ? `<div><p class="text-xs font-bold text-gray-400 mb-1">評価（${esc(ev.evaluation_period)}）</p>
        <p class="text-xs">勤怠 ${ev.attendance_score}/5 ・報告 ${ev.report_score}/5 ・実績 ${ev.performance_score}/5 ・クライアント ${ev.client_score}/5</p></div>` : ''}
      <div><p class="text-xs font-bold text-gray-400 mb-1">推薦コメント</p><p class="text-xs text-gray-600">${esc(p.memo || '真面目に稼働いただけるスタッフです。')}</p></div>
    </div>`)
}

window.showFollowModal = function (sid, name) {
  modal(`
    <h3 class="font-bold text-lg mb-4">フォロー記録 — ${esc(name)}</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">対応種別</label>
        <select id="fl-type" class="inp">${Object.entries(FOLLOW_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div><label class="text-sm text-gray-600 block mb-1">内容</label><textarea id="fl-content" rows="3" class="inp"></textarea></div>
      <div><label class="text-sm text-gray-600 block mb-1">次回対応予定</label><input id="fl-next" class="inp"></div>
      <button class="btn btn-primary w-full" onclick="addFollowLog(${sid})">記録する</button>
    </div>`)
}
window.addFollowLog = async function (sid) {
  await axios.post('/api/admin/follow-logs', {
    staff_id: sid, follow_type: document.getElementById('fl-type').value,
    content: document.getElementById('fl-content').value, next_action: document.getElementById('fl-next').value
  })
  closeModal(); toast('フォロー履歴を記録しました'); renderStaffDetail(sid)
}

// ============ 案件 ============
async function renderProjects() {
  loading()
  const { data } = await axios.get('/api/admin/projects')
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">案件管理</h2>
      <button class="btn btn-primary" onclick="showAddProject()"><i class="fas fa-plus"></i>案件登録</button>
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>案件名</th><th>クライアント</th><th>種別</th><th>稼働場所</th><th>単価</th><th>今月稼働</th><th>今月成約</th><th>インシデント</th><th>状態</th></tr></thead>
        <tbody>
          ${data.projects.map(p => `
            <tr class="cursor-pointer" onclick="location.hash='projects/${p.project_id}'">
              <td class="font-medium text-blue-700">${esc(p.project_name)}</td>
              <td class="text-xs">${esc(p.client_name || '-')}</td>
              <td><span class="badge badge-gray">${PTYPE_LABELS[p.project_type] || p.project_type}</span></td>
              <td class="text-xs">${esc(p.location || '-')}</td>
              <td>${yen(p.unit_price)}/日</td>
              <td>${p.month_shifts}件 (${p.staff_count}名)</td>
              <td class="font-bold">${p.month_seiyaku || 0}</td>
              <td>${p.incidents ? `<span class="badge badge-red">${p.incidents}件</span>` : '<span class="text-gray-300">0</span>'}</td>
              <td>${p.status === 'active' ? '<span class="badge badge-green">稼働中</span>' : '<span class="badge badge-gray">終了</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`
}

window.showAddProject = async function () {
  const [{ data: cl }, { data: tp }] = await Promise.all([axios.get('/api/admin/clients'), axios.get('/api/admin/templates')])
  modal(`
    <h3 class="font-bold text-lg mb-4">案件登録</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">案件名 *</label><input id="np-name" class="inp"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">クライアント</label>
          <select id="np-client" class="inp">${cl.clients.map(c => `<option value="${c.client_id}">${esc(c.client_name)}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">業務種別</label>
          <select id="np-type" class="inp">${Object.entries(PTYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">稼働場所</label><input id="np-loc" class="inp"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">日単価（円）</label><input id="np-price" type="number" class="inp" value="16000"></div>
        <div><label class="text-sm text-gray-600 block mb-1">日報テンプレート</label>
          <select id="np-tpl" class="inp">${tp.templates.map(t => `<option value="${t.template_id}">${esc(t.template_name)}</option>`).join('')}</select></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">求められる内容</label><textarea id="np-req" rows="2" class="inp"></textarea></div>
      <button class="btn btn-primary w-full" onclick="addProject()">登録する</button>
    </div>`)
}
window.addProject = async function () {
  const name = document.getElementById('np-name').value.trim()
  if (!name) { toast('案件名を入力してください'); return }
  await axios.post('/api/admin/projects', {
    project_name: name, client_id: document.getElementById('np-client').value,
    project_type: document.getElementById('np-type').value, location: document.getElementById('np-loc').value,
    unit_price: Number(document.getElementById('np-price').value || 0),
    report_template_id: document.getElementById('np-tpl').value, requirements: document.getElementById('np-req').value
  })
  closeModal(); toast('案件を登録しました'); renderProjects()
}

async function renderProjectDetail(pid) {
  loading()
  const { data } = await axios.get('/api/admin/projects/' + pid)
  const p = data.project
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <a href="#projects" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold text-gray-900">${esc(p.project_name)}</h2>
        <p class="text-sm text-gray-500">${esc(p.client_name || '')} ｜ ${PTYPE_LABELS[p.project_type] || ''} ｜ ${esc(p.location || '')}</p>
      </div>
      <span class="badge ${p.status === 'active' ? 'badge-green' : 'badge-gray'}">${p.status === 'active' ? '稼働中' : '終了'}</span>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      <div class="card p-4"><p class="text-xs text-gray-500">単価</p><p class="text-xl font-bold">${yen(p.unit_price)}<span class="text-xs font-normal text-gray-400">/日</span></p></div>
      <div class="card p-4"><p class="text-xs text-gray-500">今月稼働</p><p class="text-xl font-bold">${data.month_summary.n || 0}<span class="text-xs font-normal text-gray-400">件</span></p></div>
      <div class="card p-4"><p class="text-xs text-gray-500">今月売上（概算）</p><p class="text-xl font-bold">${yen(data.month_summary.revenue)}</p></div>
      <div class="card p-4"><p class="text-xs text-gray-500">日報テンプレート</p><p class="text-sm font-bold mt-1">${esc(p.template_name || '-')}</p></div>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">スタッフ別実績（今月）</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>スタッフ</th><th>日数</th><th>MNP</th><th>PI</th><th>新規</th><th>光</th><th>成約</th></tr></thead>
          <tbody>${data.staff_performance.map(s => `
            <tr><td><a href="#staff/${s.staff_id}" class="text-blue-600 hover:underline">${esc(s.name)}</a></td>
            <td>${s.days}</td><td>${s.mnp}</td><td>${s.pi}</td><td>${s.shinki}</td><td>${s.hikari}</td><td class="font-bold">${s.seiyaku}</td></tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400 py-3">データなし</td></tr>'}
          </tbody>
        </table>
        </div>
      </section>
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-bolt text-red-500 mr-1"></i>インシデント・クレーム</h3>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          ${data.incidents.map(i => `
            <div class="p-2.5 rounded-lg bg-red-50 text-xs">
              <div class="flex gap-2 mb-1">
                ${i.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
                ${i.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
                <span class="text-gray-500">${dayjs(i.work_date).format('M/D')} ${esc(i.staff_name)}</span>
              </div>
              <p class="text-gray-700">${esc((i.values && i.values.free) || '')}</p>
            </div>`).join('') || '<p class="text-sm text-gray-400">インシデントはありません</p>'}
        </div>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-2">求められる内容</h3>
        <p class="text-sm text-gray-600">${esc(p.requirements || '-')}</p>
        <h3 class="text-sm font-bold text-gray-700 mt-4 mb-2">案件マニュアル・注意事項</h3>
        <p class="text-sm text-gray-600 whitespace-pre-wrap">${esc(p.manual_text || '-')}</p>
        <h3 class="text-sm font-bold text-gray-700 mt-4 mb-2">必要スキル</h3>
        <div class="flex flex-wrap gap-1">${(p.required_skills || '').split(',').filter(Boolean).map(s => `<span class="badge badge-blue">${esc(s)}</span>`).join('') || '-'}</div>
      </section>
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-2">日報テンプレート項目</h3>
        <div class="flex flex-wrap gap-1.5">
          ${(p.template_fields || []).map(f => `<span class="badge ${f.type === 'number' ? 'badge-blue' : 'badge-gray'}">${esc(f.label)}</span>`).join('')}
        </div>
        <p class="text-xs text-gray-400 mt-3">スタッフへの実績表示: ${p.show_performance ? '表示する' : '表示しない'}</p>
      </section>
    </div>`
}

// ============ クライアント ============
async function renderClients() {
  loading()
  const { data } = await axios.get('/api/admin/clients')
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">クライアント管理</h2>
      <button class="btn btn-primary" onclick="showAddClient()"><i class="fas fa-plus"></i>クライアント登録</button>
    </div>
    <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
      ${data.clients.map(c => `
        <section class="card p-4">
          <div class="flex items-start justify-between mb-2">
            <h3 class="font-bold text-gray-800">${esc(c.client_name)}</h3>
            <span class="badge ${c.stream_type === 'upstream' ? 'badge-blue' : 'badge-purple'}">${c.stream_type === 'upstream' ? '上流' : '下流'}</span>
          </div>
          <dl class="text-xs text-gray-600 space-y-1.5">
            <div class="flex"><dt class="w-20 text-gray-400">担当者</dt><dd>${esc(c.contact_name || '-')}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">契約形態</dt><dd>${esc(c.contract_type || '-')}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">請求条件</dt><dd>${esc(c.billing_rule || '-')}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">評価</dt><dd>${'★'.repeat(c.client_rating || 0)}${'☆'.repeat(5 - (c.client_rating || 0))}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">稼働案件</dt><dd>${esc(c.active_projects || '-')}</dd></div>
          </dl>
          ${c.ng_staff_ids ? '<p class="text-xs text-red-600 mt-2"><i class="fas fa-ban mr-1"></i>NGスタッフ登録あり</p>' : ''}
          ${c.memo ? `<p class="text-xs bg-gray-50 rounded-lg px-2.5 py-1.5 mt-2 text-gray-500">${esc(c.memo)}</p>` : ''}
        </section>`).join('')}
    </div>`
}

window.showAddClient = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4">クライアント登録</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">クライアント名 *</label><input id="nc-name" class="inp"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">上流/下流</label>
          <select id="nc-stream" class="inp"><option value="upstream">上流</option><option value="downstream">下流</option></select></div>
        <div><label class="text-sm text-gray-600 block mb-1">契約形態</label>
          <select id="nc-contract" class="inp"><option>業務委託</option><option>派遣</option><option>請負</option><option>紹介</option></select></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">担当者</label><input id="nc-contact" class="inp"></div>
        <div><label class="text-sm text-gray-600 block mb-1">電話</label><input id="nc-phone" class="inp"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">請求条件</label><input id="nc-billing" class="inp" placeholder="月末締め・翌月末払い"></div>
      <div><label class="text-sm text-gray-600 block mb-1">備考</label><textarea id="nc-memo" rows="2" class="inp"></textarea></div>
      <button class="btn btn-primary w-full" onclick="addClient()">登録する</button>
    </div>`)
}
window.addClient = async function () {
  const name = document.getElementById('nc-name').value.trim()
  if (!name) { toast('クライアント名を入力してください'); return }
  await axios.post('/api/admin/clients', {
    client_name: name, stream_type: document.getElementById('nc-stream').value,
    contract_type: document.getElementById('nc-contract').value, contact_name: document.getElementById('nc-contact').value,
    phone: document.getElementById('nc-phone').value, billing_rule: document.getElementById('nc-billing').value,
    memo: document.getElementById('nc-memo').value
  })
  closeModal(); toast('クライアントを登録しました'); renderClients()
}

// ============ シフト管理 ============
async function renderShifts(dateStr) {
  loading()
  const from = dateStr || dayjs().format('YYYY-MM-DD')
  const to = dayjs(from).add(6, 'day').format('YYYY-MM-DD')
  const { data } = await axios.get(`/api/admin/shifts?from=${from}&to=${to}`)
  const days = []
  for (let i = 0; i < 7; i++) days.push(dayjs(from).add(i, 'day').format('YYYY-MM-DD'))
  const byDay = {}
  for (const s of data.shifts) { (byDay[s.work_date] = byDay[s.work_date] || []).push(s) }
  const stColor = { requested: 'bg-amber-50 border-amber-200', confirmed: 'bg-blue-50 border-blue-200', absent: 'bg-red-50 border-red-200 opacity-60', substitute: 'bg-purple-50 border-purple-200' }
  const stLabel = { requested: '希望', confirmed: '確定', absent: '欠勤', substitute: '代打' }

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">シフト管理</h2>
      <div class="flex gap-2">
        <button class="btn btn-outline" onclick="renderShifts('${dayjs(from).subtract(7, 'day').format('YYYY-MM-DD')}')"><i class="fas fa-chevron-left"></i>前週</button>
        <button class="btn btn-outline" onclick="renderShifts()">今週</button>
        <button class="btn btn-outline" onclick="renderShifts('${dayjs(from).add(7, 'day').format('YYYY-MM-DD')}')">翌週<i class="fas fa-chevron-right"></i></button>
        <button class="btn btn-primary" onclick="showAddShift('${from}')"><i class="fas fa-plus"></i>シフト登録</button>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-7 gap-2" id="shift-week">
      ${days.map(d => {
        const isToday = d === dayjs().format('YYYY-MM-DD')
        const dow = ['日', '月', '火', '水', '木', '金', '土'][dayjs(d).day()]
        return `<div class="card p-2 ${isToday ? 'ring-2 ring-blue-400' : ''}">
          <p class="text-xs font-bold text-center mb-2 ${dayjs(d).day() === 0 ? 'text-red-500' : dayjs(d).day() === 6 ? 'text-blue-500' : 'text-gray-600'}">
            ${dayjs(d).format('M/D')}(${dow})${isToday ? ' <span class="badge badge-blue">今日</span>' : ''}</p>
          <div class="space-y-1.5">
            ${(byDay[d] || []).map(s => `
              <div class="border rounded-lg p-1.5 text-xs ${stColor[s.status] || ''} cursor-pointer" onclick="showEditShift(${s.shift_id}, '${esc(s.staff_name)}', '${s.status}')">
                <p class="font-bold truncate">${esc(s.staff_name)}</p>
                <p class="text-gray-500 truncate">${esc(s.project_name)}</p>
                <p class="text-gray-400">${s.start_time}〜${s.end_time} <span class="font-bold">${stLabel[s.status] || ''}</span></p>
              </div>`).join('') || '<p class="text-xs text-gray-300 text-center py-2">-</p>'}
          </div>
        </div>`
      }).join('')}
    </div>`
}

window.showAddShift = async function (defaultDate) {
  const [{ data: st }, { data: pj }] = await Promise.all([axios.get('/api/admin/staff'), axios.get('/api/admin/projects')])
  modal(`
    <h3 class="font-bold text-lg mb-4">シフト登録</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">スタッフ *</label>
          <select id="sh-staff" class="inp">${st.staff.map(s => `<option value="${s.staff_id}">${esc(s.name)}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">案件 *</label>
          <select id="sh-project" class="inp">${pj.projects.filter(p => p.status === 'active').map(p => `<option value="${p.project_id}">${esc(p.project_name)}</option>`).join('')}</select></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">日付 *</label><input id="sh-date" type="date" class="inp" value="${defaultDate || ''}"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">開始</label><input id="sh-start" type="time" value="09:30" class="inp"></div>
        <div><label class="text-sm text-gray-600 block mb-1">終了</label><input id="sh-end" type="time" value="19:00" class="inp"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">状態</label>
          <select id="sh-status" class="inp"><option value="confirmed">確定</option><option value="requested">希望</option><option value="substitute">代打</option></select></div>
        <div><label class="text-sm text-gray-600 block mb-1">交通費</label><input id="sh-fee" type="number" value="1200" class="inp"></div>
      </div>
      <button class="btn btn-primary w-full" onclick="addShift()">登録する</button>
    </div>`)
}
window.addShift = async function () {
  const date = document.getElementById('sh-date').value
  if (!date) { toast('日付を選択してください'); return }
  await axios.post('/api/admin/shifts', {
    staff_id: document.getElementById('sh-staff').value, project_id: document.getElementById('sh-project').value,
    work_date: date, start_time: document.getElementById('sh-start').value, end_time: document.getElementById('sh-end').value,
    status: document.getElementById('sh-status').value, transportation_fee: Number(document.getElementById('sh-fee').value || 0)
  })
  closeModal(); toast('シフトを登録しました'); renderShifts(date)
}

window.showEditShift = function (shiftId, staffName, status) {
  modal(`
    <h3 class="font-bold text-lg mb-4">シフト操作 — ${esc(staffName)}</h3>
    <div class="space-y-2">
      <button class="btn btn-outline w-full" onclick="updateShift(${shiftId}, 'confirmed')"><i class="fas fa-check text-emerald-500"></i>確定にする</button>
      <button class="btn btn-outline w-full" onclick="updateShift(${shiftId}, 'absent')"><i class="fas fa-user-xmark text-red-500"></i>欠勤にする</button>
      <button class="btn btn-outline w-full" onclick="updateShift(${shiftId}, 'substitute')"><i class="fas fa-people-arrows text-purple-500"></i>代打にする</button>
      <button class="btn btn-danger w-full" onclick="deleteShift(${shiftId})"><i class="fas fa-trash"></i>削除する</button>
    </div>`)
}
window.updateShift = async function (id, status) {
  await axios.put('/api/admin/shifts/' + id, { status })
  closeModal(); toast('シフトを更新しました'); renderShifts()
}
window.deleteShift = async function (id) {
  if (!confirm('このシフトを削除しますか？')) return
  await axios.delete('/api/admin/shifts/' + id)
  closeModal(); toast('シフトを削除しました'); renderShifts()
}

// ============ 日報一覧 ============
async function renderReports(date) {
  loading()
  const q = date ? '?date=' + date : ''
  const { data } = await axios.get('/api/admin/daily-reports' + q)
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">日報一覧</h2>
      <input type="date" class="inp" style="width:auto" value="${date || ''}" onchange="renderReports(this.value)">
    </div>
    <div class="space-y-3">
      ${data.reports.map(r => `
        <section class="card p-4">
          <div class="flex items-center gap-2 flex-wrap mb-2">
            <span class="font-bold text-gray-800">${dayjs(r.work_date).format('M/D(dd)')}</span>
            <a href="#staff/${r.staff_id}" class="text-blue-600 font-medium hover:underline">${esc(r.staff_name)}</a>
            <span class="text-xs text-gray-400">${esc(r.project_name)}</span>
            ${r.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
            ${r.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
            ${r.manager_checked ? '<span class="badge badge-green">確認済</span>' : '<span class="badge badge-yellow">未確認</span>'}
            <span class="text-xs text-gray-400 ml-auto">提出 ${dayjs(r.submitted_at).format('M/D HH:mm')}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mb-2">
            ${Object.entries(r.values).filter(([k, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `<span class="badge badge-blue">${LABELS[k] || k} ${v}</span>`).join('')}
          </div>
          ${r.values.good_case ? `<p class="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5 mb-1"><i class="fas fa-star mr-1"></i>好事例: ${esc(r.values.good_case)}</p>` : ''}
          ${r.values.store_share ? `<p class="text-xs text-blue-700 bg-blue-50 rounded-lg px-2.5 py-1.5 mb-1"><i class="fas fa-store mr-1"></i>店舗共有: ${esc(r.values.store_share)}</p>` : ''}
          ${r.values.free ? `<p class="text-xs text-gray-600">${esc(r.values.free)}</p>` : ''}
          ${r.manager_comment ? `<p class="text-xs bg-gray-50 rounded-lg px-2.5 py-1.5 mt-2"><i class="fas fa-comment-dots text-gray-400 mr-1"></i>${esc(r.manager_comment)}</p>` : ''}
          <div class="flex gap-2 mt-3">
            ${!r.manager_checked ? `<button class="btn btn-outline text-xs" onclick="checkReport(${r.daily_report_id}, ${date ? `'${date}'` : 'null'})"><i class="fas fa-check"></i>確認済みにする</button>` : ''}
            <button class="btn btn-outline text-xs" onclick="commentReport(${r.daily_report_id}, ${date ? `'${date}'` : 'null'})"><i class="fas fa-comment"></i>コメント</button>
          </div>
        </section>`).join('') || '<p class="text-center text-gray-400 py-10">日報がありません</p>'}
    </div>`
}
window.checkReport = async function (id, date) {
  await axios.put('/api/admin/daily-reports/' + id, { manager_checked: 1 })
  toast('確認済みにしました'); renderReports(date)
}
window.commentReport = async function (id, date) {
  const comment = prompt('スタッフへのコメントを入力してください')
  if (!comment) return
  await axios.put('/api/admin/daily-reports/' + id, { manager_comment: comment })
  toast('コメントを送信しました'); renderReports(date)
}

// ============ 実績分析 ============
async function renderAnalytics(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  const { data } = await axios.get('/api/admin/analytics?month=' + month)
  const t = data.totals || {}
  const rate = t.shodan ? Math.round((t.seiyaku / t.shodan) * 100) : 0

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">実績分析</h2>
      <div class="flex gap-2 items-center">
        <button class="btn btn-outline" onclick="renderAnalytics('${dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-left"></i></button>
        <span class="font-bold">${dayjs(month + '-01').format('YYYY年M月')}</span>
        <button class="btn btn-outline" onclick="renderAnalytics('${dayjs(month + '-01').add(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-right"></i></button>
      </div>
    </div>
    <section class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-5">
      ${[['MNP', t.mnp], ['PI', t.pi], ['新規', t.shinki], ['機種変更', t.kishuhen], ['光回線', t.hikari], ['でんき', t.denki], ['声かけ', t.koekake], ['商談', t.shodan], ['成約', t.seiyaku], ['成約率', rate + '%'], ['日報数', t.reports], ['クレカ', t.card]].map(([l, v]) => `
        <div class="card p-3 text-center"><p class="text-xl font-bold text-blue-600">${v || 0}</p><p class="text-xs text-gray-500">${l}</p></div>`).join('')}
    </section>
    <section class="card p-4 mb-5">
      <h3 class="text-sm font-bold text-gray-700 mb-3">日別推移</h3>
      <canvas id="daily-chart" height="80"></canvas>
    </section>
    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-ranking-star text-amber-500 mr-1"></i>スタッフ別ランキング（成約順）</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>#</th><th>スタッフ</th><th>日数</th><th>MNP</th><th>光</th><th>成約</th></tr></thead>
          <tbody>${data.by_staff.map((s, i) => `
            <tr><td>${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
            <td><a href="#staff/${s.staff_id}" class="text-blue-600 hover:underline">${esc(s.name)}</a></td>
            <td>${s.days}</td><td>${s.mnp}</td><td>${s.hikari}</td><td class="font-bold">${s.seiyaku}</td></tr>`).join('')}
          </tbody>
        </table>
        </div>
      </section>
      <div class="space-y-4">
        <section class="card p-4">
          <h3 class="text-sm font-bold text-gray-700 mb-3">案件別実績</h3>
          <div class="overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>案件</th><th>日報</th><th>MNP</th><th>光</th><th>成約</th></tr></thead>
            <tbody>${data.by_project.map(p => `
              <tr><td><a href="#projects/${p.project_id}" class="text-blue-600 hover:underline text-xs">${esc(p.project_name)}</a></td>
              <td>${p.days}</td><td>${p.mnp}</td><td>${p.hikari}</td><td class="font-bold">${p.seiyaku}</td></tr>`).join('')}
            </tbody>
          </table>
          </div>
        </section>
        <section class="card p-4">
          <h3 class="text-sm font-bold text-gray-700 mb-3">クライアント別実績</h3>
          <div class="overflow-x-auto">
          <table class="tbl">
            <thead><tr><th>クライアント</th><th>日報</th><th>成約</th></tr></thead>
            <tbody>${data.by_client.map(c => `
              <tr><td class="text-xs">${esc(c.client_name)}</td><td>${c.days}</td><td class="font-bold">${c.seiyaku}</td></tr>`).join('')}
            </tbody>
          </table>
          </div>
        </section>
      </div>
    </div>`

  new Chart(document.getElementById('daily-chart'), {
    type: 'bar',
    data: {
      labels: data.daily.map(d => dayjs(d.work_date).format('M/D')),
      datasets: [
        { label: '成約', data: data.daily.map(d => d.seiyaku), backgroundColor: '#2563eb' },
        { label: 'MNP', data: data.daily.map(d => d.mnp), backgroundColor: '#10b981' },
        { label: '光回線', data: data.daily.map(d => d.hikari), backgroundColor: '#f59e0b' },
      ]
    },
    options: { responsive: true, scales: { x: { stacked: false }, y: { beginAtZero: true, ticks: { stepSize: 5 } } } }
  })
}

// ============ お知らせ配信 ============
async function renderNotices() {
  loading()
  const [{ data }, { data: pj }] = await Promise.all([axios.get('/api/admin/notices'), axios.get('/api/admin/projects')])
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">お知らせ配信</h2>
    <div class="grid lg:grid-cols-5 gap-4">
      <section class="card p-4 lg:col-span-2 h-fit">
        <h3 class="font-bold text-gray-700 mb-3"><i class="fas fa-paper-plane text-blue-600 mr-1"></i>新規配信</h3>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-600 block mb-1">タイトル *</label><input id="nt-title" class="inp"></div>
          <div><label class="text-sm text-gray-600 block mb-1">本文</label><textarea id="nt-body" rows="4" class="inp"></textarea></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label class="text-sm text-gray-600 block mb-1">配信対象</label>
              <select id="nt-target" class="inp" onchange="document.getElementById('nt-project-wrap').style.display = this.value === 'project' ? 'block' : 'none'">
                <option value="all">全スタッフ</option><option value="project">案件別</option>
              </select></div>
            <div><label class="text-sm text-gray-600 block mb-1">重要度</label>
              <select id="nt-importance" class="inp"><option value="normal">通常</option><option value="important">重要</option><option value="urgent">緊急</option></select></div>
          </div>
          <div id="nt-project-wrap" style="display:none">
            <label class="text-sm text-gray-600 block mb-1">対象案件</label>
            <select id="nt-project" class="inp">${pj.projects.map(p => `<option value="${p.project_id}">${esc(p.project_name)}</option>`).join('')}</select>
          </div>
          <label class="flex items-center gap-2 text-sm"><input id="nt-required" type="checkbox" class="w-4 h-4">既読確認を必須にする</label>
          <button class="btn btn-primary w-full" onclick="sendNotice()">配信する</button>
        </div>
      </section>
      <section class="lg:col-span-3 space-y-3">
        ${data.notices.map(n => `
          <div class="card p-4">
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              ${n.importance !== 'normal' ? '<span class="badge badge-red">重要</span>' : ''}
              <span class="badge badge-gray">${n.target_type === 'all' ? '全体' : n.target_type === 'project' ? '案件別' : '個人'}</span>
              <span class="text-xs text-gray-400">${dayjs(n.published_at).format('M/D HH:mm')}</span>
              <button class="text-xs text-blue-600 ml-auto hover:underline" onclick="showReads(${n.notice_id})">
                既読 ${n.read_count}/${n.staff_total}名</button>
            </div>
            <h3 class="font-bold text-gray-800">${esc(n.title)}</h3>
            <p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap">${esc(n.body)}</p>
          </div>`).join('')}
      </section>
    </div>`
}
window.sendNotice = async function () {
  const title = document.getElementById('nt-title').value.trim()
  if (!title) { toast('タイトルを入力してください'); return }
  const target = document.getElementById('nt-target').value
  await axios.post('/api/admin/notices', {
    title, body: document.getElementById('nt-body').value,
    target_type: target, target_ids: target === 'project' ? document.getElementById('nt-project').value : '',
    importance: document.getElementById('nt-importance').value,
    read_required: document.getElementById('nt-required').checked
  })
  toast('お知らせを配信しました'); renderNotices()
}
window.showReads = async function (id) {
  const { data } = await axios.get(`/api/admin/notices/${id}/reads`)
  modal(`
    <h3 class="font-bold text-lg mb-4">既読状況</h3>
    <div class="grid grid-cols-2 gap-4">
      <div><h4 class="text-sm font-bold text-emerald-700 mb-2">既読 ${data.read.length}名</h4>
        <div class="space-y-1 text-sm">${data.read.map(r => `<p>${esc(r.name)} <span class="text-xs text-gray-400">${dayjs(r.read_at).format('M/D HH:mm')}</span></p>`).join('') || '<p class="text-gray-400 text-xs">なし</p>'}</div></div>
      <div><h4 class="text-sm font-bold text-red-700 mb-2">未読 ${data.unread.length}名</h4>
        <div class="space-y-1 text-sm">${data.unread.map(r => `<p>${esc(r.name)}</p>`).join('') || '<p class="text-gray-400 text-xs">なし</p>'}</div></div>
    </div>`)
}

// ============ フォロー履歴 ============
async function renderFollow() {
  loading()
  const { data } = await axios.get('/api/admin/follow-logs')
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">フォロー履歴管理</h2>
    <div class="space-y-3">
      ${data.logs.map(f => `
        <section class="card p-4">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="badge badge-purple">${FOLLOW_LABELS[f.follow_type] || f.follow_type}</span>
            <a href="#staff/${f.staff_id}" class="font-bold text-blue-700 hover:underline">${esc(f.staff_name)}</a>
            <span class="text-xs text-gray-400">対応者: ${esc(f.manager_name || '-')}</span>
            <span class="text-xs text-gray-400">${dayjs(f.created_at).format('M/D HH:mm')}</span>
            ${f.status === 'open' ? `<button class="badge badge-yellow ml-auto" onclick="closeFollow(${f.follow_id})">対応中 → 完了にする</button>` : '<span class="badge badge-green ml-auto">完了</span>'}
          </div>
          <p class="text-sm text-gray-700">${esc(f.content)}</p>
          ${f.next_action ? `<p class="text-xs text-blue-700 mt-1.5 bg-blue-50 rounded-lg px-2.5 py-1.5"><i class="fas fa-arrow-right mr-1"></i>次回対応: ${esc(f.next_action)}</p>` : ''}
        </section>`).join('') || '<p class="text-center text-gray-400 py-10">フォロー履歴はありません</p>'}
    </div>`
}
window.closeFollow = async function (id) {
  await axios.put('/api/admin/follow-logs/' + id, { status: 'done' })
  toast('完了にしました'); renderFollow()
}

// ============ 相談対応 ============
async function renderConsult() {
  loading()
  const { data } = await axios.get('/api/admin/consultations')
  const stBadge = { open: '<span class="badge badge-red">未対応</span>', in_progress: '<span class="badge badge-blue">対応中</span>', done: '<span class="badge badge-green">対応済</span>' }
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">相談対応</h2>
    <div class="space-y-3">
      ${data.consultations.map(co => `
        <section class="card p-4">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="badge badge-gray">${CAT_LABELS[co.category] || co.category}</span>
            ${co.urgency === 'high' ? '<span class="badge badge-red">緊急</span>' : ''}
            <a href="#staff/${co.staff_id}" class="font-bold text-blue-700 hover:underline">${esc(co.staff_name)}</a>
            <span class="text-xs text-gray-400">${dayjs(co.created_at).format('M/D HH:mm')}</span>
            <span class="ml-auto">${stBadge[co.status] || ''}</span>
          </div>
          <p class="text-sm text-gray-700">${esc(co.body)}</p>
          ${co.manager_reply ? `<div class="mt-2 bg-blue-50 rounded-lg px-3 py-2 text-sm text-blue-900"><i class="fas fa-reply mr-1"></i>${esc(co.manager_reply)}</div>` : ''}
          <div class="flex gap-2 mt-3">
            <button class="btn btn-outline text-xs" onclick="replyConsult(${co.consultation_id})"><i class="fas fa-reply"></i>返信する</button>
            ${co.status !== 'done' ? `<button class="btn btn-outline text-xs" onclick="closeConsult(${co.consultation_id})"><i class="fas fa-check"></i>対応済みにする</button>` : ''}
          </div>
        </section>`).join('') || '<p class="text-center text-gray-400 py-10">相談はありません</p>'}
    </div>`
}
window.replyConsult = async function (id) {
  const reply = prompt('返信内容を入力してください')
  if (!reply) return
  await axios.put('/api/admin/consultations/' + id, { manager_reply: reply, status: 'in_progress' })
  toast('返信しました'); renderConsult()
}
window.closeConsult = async function (id) {
  await axios.put('/api/admin/consultations/' + id, { status: 'done' })
  toast('対応済みにしました'); renderConsult()
}

// ============ 請求前確認 ============
async function renderBilling(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  const { data } = await axios.get('/api/admin/billing-check?month=' + month)
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">請求前確認</h2>
      <div class="flex gap-2 items-center">
        <button class="btn btn-outline" onclick="renderBilling('${dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-left"></i></button>
        <span class="font-bold">${dayjs(month + '-01').format('YYYY年M月')}</span>
        <button class="btn btn-outline" onclick="renderBilling('${dayjs(month + '-01').add(1, 'month').format('YYYY-MM')}')"><i class="fas fa-chevron-right"></i></button>
        <button class="btn btn-primary" onclick="exportBillingCsv()"><i class="fas fa-file-csv"></i>CSV出力</button>
      </div>
    </div>
    <section class="card p-4 mb-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">案件別サマリー</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>案件</th><th>クライアント</th><th>稼働日数</th><th>稼働人数</th><th>欠勤</th><th>代打</th><th>日報提出</th><th>稼働金額</th><th>交通費</th><th>合計</th></tr></thead>
          <tbody>${data.by_project.map(p => `
            <tr>
              <td class="font-medium">${esc(p.project_name)}</td>
              <td class="text-xs">${esc(p.client_name || '-')}</td>
              <td>${p.work_days}</td><td>${p.staff_count}</td>
              <td>${p.absent_days ? `<span class="badge badge-red">${p.absent_days}</span>` : 0}</td>
              <td>${p.substitute_days || 0}</td>
              <td>${p.report_count}/${p.work_days} ${p.report_count < p.work_days ? '<i class="fas fa-triangle-exclamation text-amber-500" title="日報と稼働日数が一致しません"></i>' : '<i class="fas fa-check text-emerald-500"></i>'}</td>
              <td>${yen(p.total_amount)}</td><td>${yen(p.total_transport)}</td>
              <td class="font-bold">${yen((p.total_amount || 0) + (p.total_transport || 0))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">スタッフ別明細</h3>
      <div class="overflow-x-auto">
        <table class="tbl" id="billing-detail">
          <thead><tr><th>スタッフ</th><th>案件</th><th>稼働日数</th><th>欠勤</th><th>稼働金額</th><th>交通費</th><th>合計</th></tr></thead>
          <tbody>${data.detail.map(d => `
            <tr>
              <td><a href="#staff/${d.staff_id}" class="text-blue-600 hover:underline">${esc(d.name)}</a></td>
              <td class="text-xs">${esc(d.project_name)}</td>
              <td>${d.work_days}</td><td>${d.absent_days || 0}</td>
              <td>${yen(d.amount)}</td><td>${yen(d.transport)}</td>
              <td class="font-bold">${yen((d.amount || 0) + (d.transport || 0))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`
  window._billingData = data
}
window.exportBillingCsv = function () {
  const data = window._billingData
  if (!data) return
  let csv = '\uFEFFスタッフ,案件,稼働日数,欠勤,稼働金額,交通費,合計\n'
  for (const d of data.detail) {
    csv += `${d.name},${d.project_name},${d.work_days},${d.absent_days || 0},${d.amount || 0},${d.transport || 0},${(d.amount || 0) + (d.transport || 0)}\n`
  }
  const blob = new Blob([csv], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `billing_${data.month}.csv`
  a.click()
  toast('CSVをダウンロードしました')
}

// ============ ルーティング ============
const routes = {
  dashboard: renderDashboard, staff: renderStaff, projects: renderProjects, clients: renderClients,
  shifts: () => renderShifts(), reports: () => renderReports(), analytics: () => renderAnalytics(),
  notices: renderNotices, follow: renderFollow, consult: renderConsult, billing: () => renderBilling()
}

function route() {
  const hash = (location.hash || '#dashboard').slice(1)
  const [tab, id] = hash.split('/')
  document.querySelectorAll('.side-link').forEach(el => el.classList.toggle('active', el.dataset.tab === tab))
  const mob = document.getElementById('mobile-nav')
  if (mob && routes[tab]) mob.value = tab
  if (tab === 'staff' && id) return renderStaffDetail(id)
  if (tab === 'projects' && id) return renderProjectDetail(id)
  ;(routes[tab] || renderDashboard)()
}

window.addEventListener('hashchange', route)
document.getElementById('mobile-nav').addEventListener('change', e => { location.hash = e.target.value })

;(async () => {
  try {
    const { data } = await axios.get('/api/auth/me')
    ME = data
    document.getElementById('company-name').textContent = data.company_name + ' / ' + data.name
  } catch (e) { return }
  route()
})()
