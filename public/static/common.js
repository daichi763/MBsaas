// Field OS 画面共通の部品（すべてのレイアウトの head で、各画面の js より先に読み込む）
//
// 値を HTML に埋め込むときの決まり:
// - 本文・属性値に入れる値は必ず esc() を通す（属性値はダブルクォートで囲む）
// - onclick="fn('${値}')" のように、値を JS の文字列に埋め込まない。
//   ブラウザは属性値の &#39; や &quot; を元の文字に戻してから JS として実行するため、esc しても文字列を抜け出せる。
//   値は data-* 属性（esc 済み）に入れ、data-action と delegate() で処理を結び付け、処理側で el.dataset から読む。
//   onclick に埋め込んでよいのは、数値の ID と、コードに書いた固定の文字列だけ。

// dayjs の曜日・月を日本語にする（UI-1 ui-admin-11）。format('M/D(dd)') が「7/5(Su)」ではなく「7/5(日)」になる。
// CDN の ja ロケール（dayjs/locale/ja.js）と同じ値をここに書く（読み込むファイルと SRI を増やさないため）。週の始まり（日曜）は変えない
if (typeof dayjs !== 'undefined' && dayjs && typeof dayjs.locale === 'function') {
  dayjs.locale({
    name: 'ja',
    weekdays: '日曜日_月曜日_火曜日_水曜日_木曜日_金曜日_土曜日'.split('_'),
    weekdaysShort: '日_月_火_水_木_金_土'.split('_'),
    weekdaysMin: '日_月_火_水_木_金_土'.split('_'),
    months: '1月_2月_3月_4月_5月_6月_7月_8月_9月_10月_11月_12月'.split('_'),
    monthsShort: '1月_2月_3月_4月_5月_6月_7月_8月_9月_10月_11月_12月'.split('_'),
    ordinal: (n) => n + '日',
    formats: { LT: 'HH:mm', LTS: 'HH:mm:ss', L: 'YYYY/MM/DD', LL: 'YYYY年M月D日', LLL: 'YYYY年M月D日 HH:mm', LLLL: 'YYYY年M月D日 dddd HH:mm' },
    meridiem: (hour) => (hour < 12 ? '午前' : '午後'),
  })
}

// HTML の実体参照に変換する（& < > " ' `）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"'`]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[m]))
}

// 属性値用。esc に加えて改行・タブも実体参照にする（data-* に複数行の値を入れても崩れないように）
function escAttr(s) {
  return esc(s).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
}

// data-action="名前" を付けた要素がクリックされたら、delegate(名前, fn) で登録した fn(el, event) を呼ぶ。
// 例: `<button data-action="deleteDocument" data-id="${d.document_id}" data-name="${esc(d.original_file_name)}">`
//     delegate('deleteDocument', el => deleteDocument(Number(el.dataset.id), el.dataset.name))
function delegate(action, fn) { delegate.handlers[action] = fn }
delegate.handlers = {}
document.addEventListener('click', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null
  if (!el || el.disabled) return
  const fn = delegate.handlers[el.getAttribute('data-action')]
  if (fn) fn(el, ev)
})

// 処理中はボタンを無効にして二重送信を防ぐ。処理が終わったら元に戻す（例外は呼び出し元へそのまま投げる）
async function withSubmitLock(button, fn) {
  if (button && button.dataset.busy === '1') return
  const wasDisabled = button ? button.disabled : false
  if (button) { button.dataset.busy = '1'; button.disabled = true }
  try {
    return await fn()
  } finally {
    if (button) { delete button.dataset.busy; button.disabled = wasDisabled }
  }
}

// ============ 画面の共通の部品: errMsg・toast・loading・modal・closeModal（Sprint 23 #9959） ============
// 以前は admin.js・staff.js・hq.js・apply.js・report-link.js と各画面の即時関数に同じものがあった。ここに1つだけ置く。
// 画面ごとの違いは UI_PAGE と onModalClose で切り替える（各画面の js の先頭で変える）:
//   - toast の既定の表示時間: 2.5 秒。apply.js（公開の募集ページ）だけ 3 秒（UI_PAGE.toastMs = 3000）
//   - loading の上下の余白: py-20。staff.js（スタッフアプリ）だけ py-16（UI_PAGE.loadingPad = 'py-16'）
//   - closeModal の後片付け: staff.js は撮った写真のプレビューを解放、roster.js はカメラを止める、report-link.js は送る報告を忘れる
//   - closeModal を止める: report-link.js は送信中は閉じない（送信の後に閉じるときは closeModal(true)）
const UI_PAGE = { toastMs: 2500, loadingPad: 'py-20' }

// API のエラーの文言（無ければ d、それも無ければ『エラーが発生しました』）
function errMsg(e, d) {
  return (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
}

// ms: 表示する時間（長い文の知らせは長めに出す。既定は UI_PAGE.toastMs）。下の holdToasts で、エラー・長い文はさらに長く出す
function toast(msg, ms) {
  let root = document.getElementById('toast')
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
  const el = document.createElement('div')
  el.className = 'toast-msg'; el.textContent = msg
  root.appendChild(el)
  setTimeout(() => el.remove(), ms || UI_PAGE.toastMs)
}

// 画面の本文（#app）を読み込み中の表示にする
function loading() {
  const app = document.getElementById('app')
  if (app) app.innerHTML = `<div class="flex justify-center ${UI_PAGE.loadingPad}"><span class="spin"></span></div>`
}

// opts.onClose: 閉じたとき（ボタン・背景のタップ・画面の移動のどれでも）に1回だけ呼ぶ。別のモーダルに置き換えたときは呼ばない（#266）
// opts.sheet: 画面の下から出るシート（UI-2 ui-staff-03。スタッフアプリの写真の報告）。背景を押しても閉じない（撮った写真が消えないように）
let MODAL_ON_CLOSE = null
const MODAL_CLEANUPS = [] // onModalClose で登録した、閉じるたびの後片付け
let MODAL_CAN_CLOSE = null // canClose(force) が false を返したら閉じない
function modal(html, opts = {}) {
  MODAL_ON_CLOSE = typeof opts.onClose === 'function' ? opts.onClose : null
  const sheet = !!opts.sheet
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg${sheet ? ' modal-sheet' : ''}" ${sheet ? '' : 'onclick="if(event.target===this)closeModal()"'}><div class="modal-box p-5">${html}</div></div>`
}
// 画面ごとの closeModal の処理を足す。fn: 閉じるたびにモーダルを消す前に呼ぶ。opts.canClose(force): false を返したら閉じない
function onModalClose(fn, opts) {
  if (typeof fn === 'function') MODAL_CLEANUPS.push(fn)
  if (opts && typeof opts.canClose === 'function') MODAL_CAN_CLOSE = opts.canClose
}
function closeModal(force) {
  if (MODAL_CAN_CLOSE && !MODAL_CAN_CLOSE(force)) return
  for (const fn of MODAL_CLEANUPS) fn()
  const root = document.getElementById('modal-root')
  if (root) root.innerHTML = ''
  const fn = MODAL_ON_CLOSE; MODAL_ON_CLOSE = null
  if (fn) { try { fn() } catch (e) { } }
}

// モーダルの閉じ方（#9422）。入力欄のあるモーダルは、背景のタップ（入力欄から背景へのドラッグも含む）では閉じず、
// 右上の ✕ と「キャンセル」でだけ閉じる（入力が消えないように）。入力欄のない確認・表示だけのモーダルは、今までどおり背景のタップでも閉じる。
// modal()（背景に onclick="…closeModal()" を付ける作り）と、画面が独自に作るモーダルを、ここで全画面分をまとめて扱う。Esc で閉じるモーダルはない
const MODAL_INPUT_SEL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable=""], [contenteditable="true"]'
function modalHasInputs(bg) {
  const box = bg.querySelector('.modal-box')
  return !!(box && box.querySelector(MODAL_INPUT_SEL))
}
// 背景のタップで閉じる作りのモーダル（背景に onclick がある）だけを対象にする。ログインし直しなど、もともと背景で閉じないものは触らない
const modalClosesOnBackdrop = (bg) => typeof bg.onclick === 'function'
// 背景のクリックは、各画面の onclick より先に（キャプチャで）受けて止める
document.addEventListener('click', (ev) => {
  const bg = ev.target
  if (!bg || !bg.classList || !bg.classList.contains('modal-bg') || !modalClosesOnBackdrop(bg) || !modalHasInputs(bg)) return
  ev.stopImmediatePropagation()
  ev.preventDefault()
  const x = bg.querySelector('.modal-x')
  if (x && x.animate) x.animate([{ scale: '1' }, { scale: '1.35' }, { scale: '1' }], { duration: 400 })
  // 閉じない理由は、モーダルごとに1回だけ伝える
  if (!bg.dataset.backdropNoted) {
    bg.dataset.backdropNoted = '1'
    // 「キャンセル」のボタンが無いモーダルでは ✕ だけを案内する
    const hasCancel = [...bg.querySelectorAll('button')].some(b => b.textContent.trim() === 'キャンセル')
    if (typeof toast === 'function') toast(hasCancel ? '入力中の内容を閉じるときは、右上の ✕ か「キャンセル」を押してください' : '入力中の内容を閉じるときは、右上の ✕ を押してください')
  }
}, true)
// 入力欄のあるモーダルに、閉じるボタン（✕）が無ければ右上に足す（スクロールしても右上に残る）。
// 閉じるボタンは box の中のものだけを見る（#9502）。背景（.modal-bg）にも onclick="…closeModal()" があるので、:scope を付けないと
// 役割の行の削除・日付の削除などの ✕ アイコンまで「閉じるボタンがある」とみなし、✕ が付かなかった。
// aria-label が「閉じる」のボタン（data-action で閉じる作り）も閉じるボタンとみなし、二重に足さない
const MODAL_X_SEL = ':scope .modal-x, :scope [data-modal-close], :scope button[aria-label="閉じる"], :scope [onclick*="closeModal"] .fa-xmark, :scope [onclick*="closeModal"] .fa-times'
function addModalCloseButtons() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    const box = bg.querySelector('.modal-box')
    if (!box || box.querySelector(MODAL_X_SEL) || !modalClosesOnBackdrop(bg) || !modalHasInputs(bg)) return
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'modal-x text-gray-400 hover:text-gray-600'
    b.dataset.action = 'modalX'
    b.setAttribute('aria-label', '閉じる'); b.title = '閉じる'
    b.style.cssText = 'position:sticky;top:0;float:right;z-index:1;width:2rem;height:2rem;margin:-.75rem -.75rem .25rem .5rem;border-radius:9999px;background:rgba(255,255,255,.9);font-size:1.1rem;line-height:2rem;text-align:center'
    b.innerHTML = '<i class="fas fa-xmark"></i>'
    box.insertBefore(b, box.firstChild)
  })
}
// モーダルの「キャンセル」（#9633）。入力したところがあれば、閉じてよいかを確かめてから閉じる（common.js が足した ✕ も同じ）。
// 入力したかどうか: 利用者が操作した（input・change が利用者の操作で起きた）入力欄のうち、操作の前の値から変わったものがあるか。
// 操作の前の値は、モーダルを開いたとき（入力欄を描いた直後）に覚え、利用者が初めてその欄に入ったときに覚え直す（画面が後から入れた値は入力に数えない）
const MODAL_FIELD_SEL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), select, textarea, [contenteditable=""], [contenteditable="true"]'
const MODAL_INITIAL = new WeakMap() // 入力欄 → 利用者が操作する前の値
const MODAL_EDITED = new WeakSet()  // 利用者が操作した入力欄
function modalFieldValue(el) {
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : ''
  if (el.type === 'file') return el.files && el.files.length ? String(el.files.length) : ''
  if (el.isContentEditable) return el.textContent
  if (el.tagName === 'SELECT' && el.multiple) return [...el.selectedOptions].map(o => o.value).join('\n')
  return el.value
}
const modalFieldOf = (t) => (t && t.matches && t.matches(MODAL_FIELD_SEL) && t.closest('.modal-box') ? t : null)
function rememberModalFields() {
  document.querySelectorAll('.modal-bg .modal-box').forEach(box => box.querySelectorAll(MODAL_FIELD_SEL).forEach(el => {
    if (!MODAL_INITIAL.has(el)) MODAL_INITIAL.set(el, modalFieldValue(el))
  }))
}
document.addEventListener('focusin', (ev) => {
  const el = modalFieldOf(ev.target)
  if (el && !MODAL_EDITED.has(el)) MODAL_INITIAL.set(el, modalFieldValue(el))
}, true)
for (const type of ['input', 'change']) document.addEventListener(type, (ev) => {
  const el = ev.isTrusted && modalFieldOf(ev.target)
  if (el) MODAL_EDITED.add(el)
}, true)
function modalIsDirty(bg) {
  const box = bg && bg.querySelector('.modal-box')
  if (!box) return false
  return [...box.querySelectorAll(MODAL_FIELD_SEL)].some(el => {
    if (!MODAL_EDITED.has(el) || el.disabled) return false
    // 操作の前の値を覚えていない欄（チェックを押しても focus が来ない端末など）は、HTML に書いた初めの値と比べる
    const init = MODAL_INITIAL.has(el) ? MODAL_INITIAL.get(el)
      : el.type === 'checkbox' || el.type === 'radio' ? (el.defaultChecked ? '1' : '') : el.type === 'file' ? '' : el.isContentEditable ? '' : el.tagName === 'SELECT' ? null : el.defaultValue
    return modalFieldValue(el) !== init
  })
}
function closeModalBg(bg) {
  // #modal-root のモーダルは各画面の closeModal で閉じる（閉じたときの後片付けがあるため）。それ以外は背景ごと外す
  if (bg.closest('#modal-root') && typeof window.closeModal === 'function') window.closeModal()
  else bg.remove()
}
function closeModalIfConfirmed(el) {
  const bg = el.closest('.modal-bg')
  if (!bg) return
  if (modalIsDirty(bg) && !confirm('入力した内容は保存されていません。閉じてよいですか？')) return
  closeModalBg(bg)
}
delegate('modalX', closeModalIfConfirmed)
delegate('modalCancel', closeModalIfConfirmed)
// 入力のあるモーダルの下のボタンの並び（#9633）: 左に「キャンセル」、右に保存などの主なボタン（flex-1 で同じ幅にそろえる）
const MODAL_CANCEL_BTN = '<button type="button" class="btn btn-outline flex-1" data-action="modalCancel">キャンセル</button>'
let modalScanQueued = false
// MutationObserver の無い環境（テストで common.js だけを読み込むときなど）では、✕ を足す処理と、開いたときの値を覚える処理を省く
if (typeof MutationObserver === 'function' && document.documentElement) {
  new MutationObserver(() => {
    if (modalScanQueued) return
    modalScanQueued = true
    queueMicrotask(() => { modalScanQueued = false; addModalCloseButtons(); rememberModalFields(); holdToasts() })
  }).observe(document.documentElement, { childList: true, subtree: true })
}

// トーストの表示時間（Sprint 15 #9708）。toast（上の共通の関数）は 2.5〜3 秒で el.remove() する。
// ここで全画面分をまとめて扱う: エラー・「できない」理由・入力の案内は長めに出し（8 秒〜。文が長いほど延ばす。最大 20 秒）、✕ で閉じられるようにする。
// 成功などの短い知らせは今のまま。長い文の知らせは、読める時間（1文字あたり約 0.11 秒。最大 10 秒）まで延ばす。
// 呼び出し側が長めの時間を指定したとき（staff.js の toast(msg, ms)）は、その時間を短くしない
const TOAST_ALERT_RE = /できません|できない|失敗|エラー|見つかりません|ありません|許可されません|権限|てください|が必要です|大きすぎ|正しくありません|重複|超え|締めて|不足|中です/
const TOAST_KEEP_MAX = 5
function toastHoldMs(text, alert) {
  const n = String(text || '').length
  return alert ? Math.min(20000, Math.max(8000, 3000 + n * 150)) : Math.min(10000, n * 110)
}
function holdToasts() {
  document.querySelectorAll('#toast > .toast-msg:not([data-toast-held])').forEach(holdToast)
}
function holdToast(el) {
  el.dataset.toastHeld = '1'
  const text = (el.textContent || '').trim()
  const alert = TOAST_ALERT_RE.test(text)
  const want = toastHoldMs(text, alert), shownAt = Date.now()
  const removeNow = () => Element.prototype.remove.call(el)
  // 画面の toast の時間で消そうとしたときに、まだ読める時間がたっていなければ、残りの時間だけ待ってから消す
  el.remove = function () {
    const left = want - (Date.now() - shownAt)
    if (left > 50) setTimeout(removeNow, left); else removeNow()
  }
  if (alert) {
    el.setAttribute('role', 'alert')
    el.style.cssText += ';display:flex;align-items:flex-start;gap:.75rem;pointer-events:auto'
    const x = document.createElement('button')
    x.type = 'button'
    x.setAttribute('aria-label', '閉じる'); x.title = '閉じる'
    x.style.cssText = 'flex-shrink:0;margin:-.15rem -.4rem 0 0;width:1.5rem;height:1.5rem;border-radius:9999px;color:#d1d5db;font-size:1rem;line-height:1.5rem;text-align:center;background:transparent'
    x.textContent = '✕'
    x.addEventListener('click', removeNow)
    el.appendChild(x)
  }
  // 長く出すトーストが積み重なりすぎないよう、古いものから消す
  const list = el.parentNode ? [...el.parentNode.querySelectorAll(':scope > .toast-msg')] : []
  for (const old of list.slice(0, Math.max(0, list.length - TOAST_KEEP_MAX))) Element.prototype.remove.call(old)
}

// API のエラー文言（無ければ fallback）を toast で出す。toast の無い画面では alert で出す
function showApiError(e, fallback) {
  const msg = errMsg(e, fallback)
  if (typeof toast === 'function') toast(msg)
  else alert(msg)
  return msg
}

// シフトの時刻の表示（#415 #547）。終了が開始以前のシフト（22:00〜06:00 など。日をまたぐ勤務）は、終了に『翌』を付ける。
// sep は区切り（既定は『〜』）。戻り値はエスケープしていないので、HTML に入れるときは esc() を通す
function formatShiftTime(start, end, sep) {
  const s = String(start || '').slice(0, 5), e = String(end || '').slice(0, 5)
  const min = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
  const next = min(s) != null && min(e) != null && min(e) <= min(s)
  return `${s}${sep == null ? '〜' : sep}${next ? '翌' : ''}${e}`
}

// 報告の日時（'YYYY-MM-DD HH:MM[:SS]'）の表示。稼働日と同じ日なら時刻だけ、違う日（日をまたいだ後の報告）なら『10/16 01:30』（#547）
function formatReportedTime(at, workDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(String(at || ''))
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}` === String(workDate || '').slice(0, 10) ? m[4] : `${Number(m[2])}/${Number(m[3])} ${m[4]}`
}

// 数字の入力欄の全角を半角にそろえる（#9704）。全角の数字・小数点・マイナス（長音・ダッシュを含む）・プラスを半角にし、
// 桁区切りのカンマと空白（全角・半角）を除く（サーバー側の src/lib/validate.ts の halfWidthNumber と同じ規則）。
// 全画面の数字の欄（type=number・tel、inputmode=numeric・decimal・tel、data-halfwidth を付けた欄）に、下でまとめて効かせる:
// - 入力の確定時（change・欄を離れたとき・ボタンを押す直前）に、欄の値をそろえる
// - type=number の欄は、全角のまま確定すると値が空になるブラウザ（Safari・Firefox）があるため、IME の確定と貼り付けの時点でそろえる。
//   それでも数として読めないまま欄を離れたときは、空のまま保存されないように知らせる
function toHalfWidthNumber(v) {
  return String(v == null ? '' : v).replace(/[\uFF10-\uFF19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\uFF0E/g, '.').replace(/[\uFF0D\u2212\u2010-\u2015\u30FC\uFF70]/g, '-').replace(/\uFF0B/g, '+')
    .replace(/[,\uFF0C\s\u3000]/g, '')
}
toHalfWidthNumber.SELECTOR = 'input[type=number], input[type=tel], input[inputmode=numeric], input[inputmode=decimal], input[inputmode=tel], input[data-halfwidth]'
;(function () {
  const isNumField = (el) => !!(el && el.matches && el.matches(toHalfWidthNumber.SELECTOR) && !el.readOnly && !el.disabled)
  const notify = (el) => el.dispatchEvent(new Event('input', { bubbles: true }))
  const fix = (el) => {
    if (!isNumField(el)) return
    if (el.type === 'number') {
      if (el.validity && el.validity.badInput && typeof toast === 'function') toast('数字は半角で入力してください（読み取れない値は保存されません）')
      return
    }
    const s = toHalfWidthNumber(el.value)
    if (s !== el.value) { el.value = s; notify(el) }
  }
  const before = new WeakMap() // IME で入力を始める前の値（type=number の欄）
  document.addEventListener('compositionstart', (ev) => { if (isNumField(ev.target) && ev.target.type === 'number') before.set(ev.target, ev.target.value) }, true)
  document.addEventListener('compositionend', (ev) => {
    const el = ev.target
    if (!isNumField(el) || el.type !== 'number') return
    const prev = before.get(el) || '', data = ev.data || ''
    setTimeout(() => {
      if (el.value !== '' && !(el.validity && el.validity.badInput)) return // ブラウザが半角にした（Chrome など）
      const s = toHalfWidthNumber(prev + data)
      if (s !== '' && Number.isFinite(Number(s))) { el.value = s; notify(el) }
    }, 0)
  }, true)
  document.addEventListener('paste', (ev) => {
    const el = ev.target
    if (!isNumField(el) || el.type !== 'number' || !ev.clipboardData) return
    const t = ev.clipboardData.getData('text'), s = toHalfWidthNumber(t)
    if (s === t || s === '' || !Number.isFinite(Number(s))) return
    ev.preventDefault(); el.value = s; notify(el)
  }, true)
  // 画面の処理より先にそろえる（キャプチャで受ける）
  document.addEventListener('change', (ev) => fix(ev.target), true)
  document.addEventListener('blur', (ev) => fix(ev.target), true) // 欄の onblur の処理より先に動く
  document.addEventListener('click', () => { const a = document.activeElement; if (a && a.type !== 'number') fix(a) }, true)
})()
