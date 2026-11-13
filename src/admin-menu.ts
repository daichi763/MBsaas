// 管理画面（/admin）のメニューと画面の一覧（#9961）。
// 左のメニュー・スマホのメニュー（上のヘッダーの選択欄）・画面の登録（public/static/admin.js の routes）は、すべてこの配列から作る。
// 項目を足す・消す・並べ替えるときは、ここだけを直す（画面を描く関数は render に名前で書く。すべての JS を読み込んだ後に window から呼ぶ）。
// #タブ/<id> の詳細・サブ画面（スタッフ詳細など）は admin.js の route() が描く

export type AdminMenuItem = {
  hash: string
  /** 左のメニューの名前 */
  label: string
  /** スマホのメニューの名前（省くと label） */
  short?: string
  /** Font Awesome のアイコン（fa-xxx） */
  icon: string
  /** 見出し（ADMIN_MENU_GROUPS のキー）。省くと見出しの外（上） */
  group?: string
  /** 件数のバッジの id。'' はバッジを画面の JS が足す（企業間チャット）。省くとバッジなし */
  badge?: string
  /** true: 労務情報を扱えるロール（会社管理者・事務担当。src/api.ts の HR_ROLES）だけに出す（#205。API でも同じ判定で止める） */
  hr?: boolean
  /** 画面を描く関数の名前（public/static/*.js で window から呼べるもの） */
  render: string
}

// 左のメニューの見出し（押すと閉じたり開いたりする。#9305）。並びはこの順
export const ADMIN_MENU_GROUPS: [key: string, label: string][] = [
  ['attendance', 'シフト・勤怠'],
  ['people', '人材'],
  ['deals', '案件・取引'],
  ['money', 'お金'],
  ['notices', 'お知らせ'],
  ['analytics', '分析'],
  ['settings', '設定'],
]

// メニューの項目。見出しの中の並びはこの順
export const ADMIN_MENU: AdminMenuItem[] = [
  // ダッシュボードの上の「はじめにやること」（#9711）も描く（admin.js の renderDashboardPage）
  { hash: 'dashboard', label: 'ダッシュボード', icon: 'fa-gauge-high', render: 'renderDashboardPage' },
  { hash: 'notifications', label: '通知', icon: 'fa-bell', badge: 'notif-badge', render: 'renderNotificationsInbox' },

  { group: 'attendance', hash: 'shifts', label: 'シフト管理', short: 'シフト', icon: 'fa-calendar-days', render: 'renderShiftBoard' },
  // 出勤可能日（#171）: 締切・未提出の人への通知・日付×スタッフの一覧
  { group: 'attendance', hash: 'availability', label: '出勤可能日', icon: 'fa-calendar-check', render: 'renderAvailabilityBoard' },
  { group: 'attendance', hash: 'reports', label: '日報一覧', short: '日報', icon: 'fa-file-lines', render: 'renderReports' },
  { group: 'attendance', hash: 'corrections', label: '打刻修正承認', icon: 'fa-user-clock', badge: 'corrections-badge', render: 'renderCorrections' },
  // スタッフの申請（登録情報の変更 #272・提出書類と期限 #288 #297・休暇 #289）
  { group: 'attendance', hash: 'staff-requests', label: 'スタッフの申請', icon: 'fa-file-signature', badge: 'staff-requests-badge', render: 'renderStaffRequests' },
  { group: 'attendance', hash: 'report-settings', label: '案件報告管理', icon: 'fa-list-check', render: 'renderReportSettings' },
  { group: 'attendance', hash: 'attendance-history', label: '履歴・CSV', icon: 'fa-clock-rotate-left', render: 'renderAttendanceHistory' },

  { group: 'people', hash: 'staff', label: 'スタッフマスタ', icon: 'fa-users', render: 'renderStaff' },
  { group: 'people', hash: 'employees', label: '従業員管理', icon: 'fa-id-card', hr: true, render: 'renderEmployees' },
  { group: 'people', hash: 'partners', label: '協力会社', icon: 'fa-handshake', render: 'renderPartners' },
  { group: 'people', hash: 'recruit', label: '募集・応募', icon: 'fa-bullhorn', badge: 'recruit-badge', render: 'renderRecruit' },
  { group: 'people', hash: 'consult', label: '相談対応', short: '相談', icon: 'fa-comments', render: 'renderConsult' },
  { group: 'people', hash: 'follow', label: 'フォロー履歴', short: 'フォロー', icon: 'fa-handshake-angle', render: 'renderFollow' },

  { group: 'deals', hash: 'projects', label: '案件管理', short: '案件', icon: 'fa-briefcase', render: 'renderProjects' },
  { group: 'deals', hash: 'clients', label: 'クライアント', icon: 'fa-building', render: 'renderClients' },
  { group: 'deals', hash: 'board', label: '案件掲示板', icon: 'fa-clipboard-list', badge: 'board-badge', render: 'renderBoard' },
  { group: 'deals', hash: 'roster-chat', label: '企業間チャット', icon: 'fa-people-arrows', badge: '', render: 'renderRosterChatList' },

  { group: 'money', hash: 'settlement', label: '精算（請求・支払）', short: '精算', icon: 'fa-scale-balanced', render: 'renderSettlement' },
  { group: 'money', hash: 'billing', label: '請求前確認', icon: 'fa-file-invoice-yen', render: 'renderBilling' },

  { group: 'notices', hash: 'notices', label: 'お知らせ配信', short: 'お知らせ', icon: 'fa-bullhorn', render: 'renderNotices' },
  { group: 'notices', hash: 'notice-reports', label: '既読率レポート', icon: 'fa-chart-pie', render: 'renderNoticeReadReport' },

  { group: 'analytics', hash: 'analytics', label: '実績分析', short: '分析', icon: 'fa-chart-column', render: 'renderAnalytics' },

  { group: 'settings', hash: 'account', label: 'アカウント設定', icon: 'fa-user-gear', render: 'renderAccount' },
  { group: 'settings', hash: 'security', label: 'セキュリティ', icon: 'fa-shield-halved', render: 'renderSecurity' },
]

// メニューにない画面（ほかの画面のリンクから開く）
export const ADMIN_EXTRA_SCREENS: { hash: string, render: string }[] = [
  // 連携先からの追記（現場評価・稼働メモ）の一覧（企業間チャット・スタッフ詳細のリンクから開く）
  { hash: 'roster-notes', render: 'openRosterHostNotes' },
]

// 労務情報（給与・口座・保険番号など）を扱えるロール（src/api.ts の HR_ROLES と同じ）
const HR_ROLES = ['company_admin', 'office_staff']
const visibleItems = (role: string) => ADMIN_MENU.filter(m => !m.hr || HR_ROLES.includes(role))

const sideLink = (m: AdminMenuItem) => m.badge === undefined
  ? `<a href="#${m.hash}" class="side-link" data-tab="${m.hash}"><i class="fas ${m.icon} w-5"></i>${m.label}</a>`
  : `<a href="#${m.hash}" class="side-link flex items-center" data-tab="${m.hash}"><i class="fas ${m.icon} w-5"></i>${m.label}${m.badge ? `<span id="${m.badge}" class="hidden ml-auto text-3xs bg-danger-500 text-white rounded-full px-1.5 py-0.5"></span>` : ''}</a>`

// 左のメニューの見出し（押すと閉じたり開いたりする。開閉は admin.js が localStorage に覚える）。
// 閉じたときは、中の項目の未読などの件数の合計を見出しの横に出す
const sideNavGroup = (key: string, label: string, links: string) => `<div class="nav-group" data-group="${key}">
          <button type="button" class="nav-group-head" data-action="navGroupToggle" aria-expanded="true" aria-controls="nav-group-${key}"><span class="flex-1 text-left">${label}</span><span class="nav-group-count hidden" aria-label="未対応の件数"></span><i class="fas fa-chevron-down nav-group-caret" aria-hidden="true"></i></button>
          <div class="nav-group-body space-y-0.5" id="nav-group-${key}">${links}
          </div>
        </div>`

/** 左のメニュー（#side-nav の中）。role のロールに出す項目だけ。項目のない見出しは出さない */
export function adminSideNavHtml(role: string): string {
  const items = visibleItems(role)
  const top = items.filter(m => !m.group).map(m => `\n        ${sideLink(m)}`).join('')
  const groups = ADMIN_MENU_GROUPS.map(([key, label]) => {
    const links = items.filter(m => m.group === key).map(m => `\n          ${sideLink(m)}`).join('')
    return links ? `\n        ${sideNavGroup(key, label, links)}` : ''
  }).join('')
  return top + groups
}

/** スマホのメニュー（#mobile-nav の選択欄の中）。左のメニューと同じ項目・並び */
export function adminMobileNavHtml(role: string): string {
  const items = visibleItems(role)
  const opt = (m: AdminMenuItem) => `<option value="${m.hash}">${m.short || m.label}</option>`
  const top = items.filter(m => !m.group).map(opt).join('')
  const groups = ADMIN_MENU_GROUPS.map(([key, label]) => {
    const opts = items.filter(m => m.group === key).map(opt).join('')
    return opts ? `\n          <optgroup label="${label}">${opts}</optgroup>` : ''
  }).join('')
  return `\n          ${top}${groups}\n        `
}

/** 画面の一覧（[hash, 描く関数の名前]）。admin.js が routes を作るのに使う（window.ADMIN_SCREENS）。ロールで出さない画面も入れる（開いたときの案内は route() が出す） */
export function adminScreensJson(): string {
  return JSON.stringify([...ADMIN_MENU, ...ADMIN_EXTRA_SCREENS].map(m => [m.hash, m.render]))
}
