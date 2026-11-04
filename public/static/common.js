// Field OS 画面共通の部品（すべてのレイアウトの head で、各画面の js より先に読み込む）
//
// 値を HTML に埋め込むときの決まり:
// - 本文・属性値に入れる値は必ず esc() を通す（属性値はダブルクォートで囲む）
// - onclick="fn('${値}')" のように、値を JS の文字列に埋め込まない。
//   ブラウザは属性値の &#39; や &quot; を元の文字に戻してから JS として実行するため、esc しても文字列を抜け出せる。
//   値は data-* 属性（esc 済み）に入れ、data-action と delegate() で処理を結び付け、処理側で el.dataset から読む。
//   onclick に埋め込んでよいのは、数値の ID と、コードに書いた固定の文字列だけ。

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

// モーダルの閉じ方（#9422）。入力欄のあるモーダルは、背景のタップ（入力欄から背景へのドラッグも含む）では閉じず、
// 右上の ✕ と「キャンセル」でだけ閉じる（入力が消えないように）。入力欄のない確認・表示だけのモーダルは、今までどおり背景のタップでも閉じる。
// 各画面の modal()（背景に onclick="…closeModal()" を付ける作り）はそのままで、ここで全画面分をまとめて扱う。Esc で閉じるモーダルはない
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

// トーストの表示時間（Sprint 15 #9708）。toast は画面ごと（admin.js・staff.js・hq.js など）にあり、どれも 2.5〜3 秒で el.remove() する。
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
  const msg = (e && e.response && e.response.data && e.response.data.error) || fallback || 'エラーが発生しました'
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
