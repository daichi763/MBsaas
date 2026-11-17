// w30-ui-staff（Sprint 30 #9986。11/16 の打合せの画面の新旧比較で採用したスタッフアプリの直し）の統合テスト
//  No.1  打刻を送ったあと、記録した時刻をホームの先頭のカードで出す（遅刻・位置なしは黄色のカードで1件ずつ。「遅れた理由を送る」）
//  No.2  まだ押せない報告は点線の枠と鍵。押すとすぐ下に理由（打刻履歴への案内）
//  No.3  前日までの報告漏れを1行にまとめる（出す場所は今のまま＝ホームの上のほう）。件数を「その他」のタブの印にも足す
//  No.4  日報の空欄を、送るときにまとめて示す（全部の欄に赤い枠と「＊未入力です」、先頭に一覧と「空欄を0にする」）。提出のボタンは下に固定
//  No.5  打刻履歴で、まだ予定の時刻になっていない報告は「これから」とし、申請のボタンを出さない
//  No.10 次の報告のボタンを下のタブの上に固定（入店の時刻が30分以内なら、起床・出発が未報告でも入店を出す）
//  No.12 位置情報が取れないとき、許可されていない・取れない・時間切れで案内を出し分け、iPhone・Android の手順と「もう一度取る」を出す
//  No.14 写真の要らない報告は1回押すだけ（送った直後は少しの間押せない）。未確定のシフト・休憩5分以内の確認は残す
//  見送った項目（No.8 ボタン44px・No.11 押すとすぐカメラ・No.13 カメラを閉じたときの案内）と言葉の変更（ui-staff-07）は入れていないことも確かめる。
//  打刻の送り方（端末に保存して送る・送り直し・同じ一意キーで二重に記録しない）は変えていない: 画面で電波を切って押し、戻してから送られた報告が1件だけであることを確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9020 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:9020 node --import ./scripts/fetch-origin.mjs scripts/test-w30-ui-staff.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写し（390px・1280px）を残す
//   （打合せの資料 打合せ/20261116_共有用/2_画面の新旧比較/img/ui1・ui2 の after と見比べる）。
//   時刻に頼る確認（30分以内の入店・遅刻）は、日本時間の 1:30〜20:30 の間だけ行う（日をまたぐシフトにしないため。外の時刻は SKIP と出す）
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9020'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}`)
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${String(r.text).slice(0, 300)}`); return r.data }
const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst(Date.now()).slice(0, 10)
const yesterday = jst(Date.now() - 86400000).slice(0, 10)
const hm = (ms) => jst(ms).slice(11, 16)
const nowMin = (() => { const t = jst(Date.now()); return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) })()
const TIMED = nowMin >= 90 && nowMin <= 20 * 60 + 30

// ---------- コード ----------
const staffJs = read('public/static/staff.js'), attJs = read('public/static/staff-attendance.js'), formJs = read('public/static/report-form.js')
const css = read('src/input.css'), built = read('public/static/style.css')
const fnBody = (src, head) => { const i = src.indexOf(head); if (i < 0) return ''; const j = src.indexOf('\n})', i); const k = src.indexOf('\n}\n', i); const e = [j, k].filter(x => x > i).sort((a, b) => a - b)[0]; return src.slice(i, e > 0 ? e + 3 : i + 4000) }
const homeReport = fnBody(staffJs, "delegate('homeReport'")
ok('No.14 写真の要らない報告は確認なしで送る（勤務終了・退店の「よろしいですか」の確認をなくした）', homeReport && !/よろしいですか/.test(homeReport) && /submitAttendance\(type, shiftId, el\)/.test(homeReport), homeReport.slice(0, 300))
ok('No.14 未確定のシフトの確認・休憩5分以内の確認は残す', /HOME\.tentative && !confirm\(TENTATIVE_CONFIRM\)/.test(homeReport) && /mins < SHORT_BREAK_MINUTES && !confirm\(/.test(homeReport))
ok('No.11 見送り: 入店・退店は今の流れ（飛ばす報告があれば確認 → 写真の画面）のまま', /if \(photoOn && PHOTO_REQUIRED_TYPES\.includes\(type\)\) \{\n\s+if \(skipping\.length && !confirm\(/.test(homeReport) && /openPhotoAttendance\(type, shiftId\)/.test(homeReport))
ok('No.11・No.13 見送り: 押してすぐカメラを開く仕組み・下から出るシート・カメラを閉じたときの案内は入れない', !/photoOpenPicker|modal-sheet|photo-closed-msg|PHOTO_PICKER/.test(staffJs + css) && /カメラで撮影/.test(staffJs) && /アルバムから選択/.test(staffJs))
ok('No.8 見送り: スマホのボタン 44px（tap-44・min-height: 44px）は入れない', !/tap-44|min-height: 44px/.test(staffJs + formJs + css))
ok('言葉は今のまま（ui-staff-07 の言い換えを入れない: 休憩入・休憩出・稼働・打刻履歴・追加申請）',
  /break_start: '休憩入', break_end: '休憩出'/.test(staffJs) && /break_start: '休憩入', break_end: '休憩出'/.test(attJs)
  && !/休憩はじめ|休憩おわり|お仕事|押し忘れを送る|報告の履歴|時刻の直し/.test(staffJs + attJs + formJs) && /'追加申請'/.test(attJs) && /今日の稼働/.test(staffJs))
ok('No.10 次の報告の固定のボタン（homeNextBarHtml・30分以内なら入店・送った直後は少しの間押せない）', /function homeNextBarHtml\(data\)/.test(staffJs) && /const NEXT_LOOKAHEAD_MIN = 30/.test(staffJs)
  && /NEXT_BAR_HOLD_UNTIL = Date\.now\(\) \+ NEXT_BAR_HOLD_MS/.test(staffJs) && /el\.dataset\.fromBar && Date\.now\(\) < NEXT_BAR_HOLD_UNTIL/.test(homeReport) && /\$\{homeNextBarHtml\(data\)\}/.test(staffJs))
ok('No.10 報告の一覧（案内が指す #attendance-section）はそのまま残す', /id="attendance-section"/.test(staffJs))
ok('No.1 結果のカード（#home-result・遅れた理由を送る・位置情報の案内）', /<div id="home-result">\$\{homeResultHtml\(data\)\}<\/div>/.test(staffJs) && /data-action="punchLateReason"/.test(staffJs) && /data-action="punchLocationHelp"/.test(staffJs))
ok('No.2 押せない報告は無効にせず（aria-disabled）、押すと理由を出す（homeReportExplain）', /locked \? 'aria-disabled="true"' : ''/.test(staffJs) && /function homeReportExplain\(/.test(staffJs) && /states\[type\] === 'skipped' \|\| states\[type\] === 'pending'\) \{ homeReportExplain/.test(homeReport))
ok('No.3 前日までの報告漏れは1行（details）で、出す場所は今のまま（シフトのカードより前）', /<details class="[^"]*" id="missed-reports">/.test(staffJs)
  && /\$\{homeMissedHtml\(data\)\}\n\s+\$\{data\.shift \? homeShiftCardHtml/.test(staffJs) && /set\('nav-more-badge', notices \+ notifs \+ missed\)/.test(staffJs))
ok('No.4 日報: 送る前にまとめて確かめる（reportFormCheck）・提出のボタンはスタッフアプリだけ下に固定', /function reportFormCheck\(form\)/.test(formJs) && /if \(reportFormCheck\(form\)\) return/.test(staffJs) && /stickySubmit: true/.test(staffJs) && /o\.stickySubmit \? '<div class="report-submit-bar">'/.test(formJs))
ok('No.5 打刻履歴: 予定の時刻前は「これから」で申請のボタンを出さない（notDueYet）', /function notDueYet\(s, t\)/.test(attJs) && /upcoming \? 'これから' : '未報告'/.test(attJs) && /: upcoming \? ''/.test(attJs))
ok('No.12 位置情報の失敗の理由を出し分ける（denied・unavailable・timeout と iPhone・Android の手順・もう一度取る）', /const GEO_ERR_BY_CODE = \{ 1: 'denied', 2: 'unavailable', 3: 'timeout' \}/.test(staffJs) && /GEO_FIX_IOS/.test(staffJs) && /GEO_FIX_ANDROID/.test(staffJs) && /もう一度取る/.test(staffJs))
ok('onclick などに値を埋め込まない（新しいボタンは data-action）', !/onclick="[^"]*\$\{/.test(staffJs.slice(staffJs.indexOf('// ---------- 次の報告の固定のボタン'), staffJs.indexOf('function homeOfflineHtml'))) && !/onclick=/.test(fnBody(formJs, 'function reportFormCheck')))
// CSS（トークンだけ。#xxxxxx を直に書かない）
const newRules = (css.match(/\.report-btn\.locked \{[^}]*\}|\.next-bar[^{]*\{[^}]*\}|\.report-submit-bar \{[^}]*\}|body\.has-next-bar #toast \{[^}]*\}/g) || [])
ok('CSS: 点線の枠・固定のボタン・日報の提出のバーは、トークン（:root の変数）だけで書く', newRules.length >= 6 && newRules.every(r => !/#[0-9a-fA-F]{3,6}\b|rgba?\(\d/.test(r)) && newRules.some(r => /border-style: dashed/.test(r)), newRules)
ok('CSS: ビルドした style.css に出ている', /\.report-btn\.locked\{/.test(built) && /\.next-bar\{position:fixed/.test(built) && /\.report-submit-bar\{position:sticky/.test(built) && /body\.has-next-bar #toast\{/.test(built))

// ---------- API: 人・シフトを作る ----------
const PFX = 'W30S' + Date.now().toString(36).slice(-4).toUpperCase()
const NEWPW = 'W30-staff-pass-2026'
const adminCk = await login('sample', 'admin')
const admin = client(adminCk)
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  const st = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
  const c0 = client(await login('sample', `${PFX}${k}`))
  must(await c0.post('/api/auth/change-password', { current_password: 'pass1234', new_password: NEWPW }), 'change pw ' + k)
  const ck = await login('sample', `${PFX}${k}`, NEWPW)
  must(await client(ck).put('/api/staff/tours', { items: [{ key: 'staff-welcome', status: 'skipped', step: 0 }] }), 'tour ' + k)
  return { ...st, ck, api: client(ck) }
}
async function createShift(staff_id, project_id, work_date, start_time, end_time) {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
const reportsOf = async (sid) => must(await admin.get(`/api/admin/shifts/${sid}/report-status`), 'report-status').reports
const countOf = (reports, type) => (Array.isArray(reports) ? reports.filter(r => r.report_type === type && (r.reported_at || r.status)).length : reports && reports[type] ? 1 : 0)
const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
const PID = (projects.find(p => p.report_template_id != null && p.status === 'active') || projects[0]).project_id
// 幅（390px・1280px）ごとに別の人を使う（押した報告が次の幅の確認に残らないように）
// A: 入店まで20分（起床・出発は未報告）→ 固定のボタンは入店。B: 開始まで3時間 → 起床。C: 1時間前に始まったシフト（遅刻）と、昨日の報告漏れ
const ms = Date.now()
const P = {}
for (const w of [390, 1280]) {
  const A = await newStaff('A' + w), B = await newStaff('B' + w), C = await newStaff('C' + w)
  P[w] = { A, B, C,
    sidA: TIMED ? await createShift(A.staff_id, PID, today, hm(ms + 20 * 60000), hm(ms + 240 * 60000)) : null,
    sidB: TIMED ? await createShift(B.staff_id, PID, today, hm(ms + 180 * 60000), '23:59') : null,
    sidC: TIMED ? await createShift(C.staff_id, PID, today, hm(ms - 60 * 60000), '23:59') : null,
    sidCy: await createShift(C.staff_id, PID, yesterday, '10:00', '18:00') }
}
const { B, sidB } = P[390]

// 同じ一意キーで2回送っても1件だけ（打刻の送り方は変えていない）
if (sidB) {
  const key = 'w30k' + Math.random().toString(36).slice(2)
  const body = { shift_id: sidB, report_type: 'wake_up', latitude: null, longitude: null, address: null, client_request_id: key, pressed_at: Date.now(), device_now: Date.now() }
  const r1 = await B.api.post('/api/staff/attendance', body), r2 = await B.api.post('/api/staff/attendance', body)
  ok('API: 同じ一意キーで2回送っても、2回とも成功し記録は1件（二重記録0件）', r1.status === 200 && r2.status === 200 && countOf(await reportsOf(sidB), 'wake_up') === 1, { r1: r1.status, r2: r2.status })
  // 画面の確認のために起床を取り消す（押し間違いの取消。5分以内）
  const w = await B.api.post('/api/staff/attendance/withdraw', { shift_id: sidB, report_type: 'wake_up', no_break: false })
  ok('（前提）起床の報告を取り消して、画面の確認に使う', w.status === 200 && countOf(await reportsOf(sidB), 'wake_up') === 0, w)
} else skip('API: 同じ一意キーの二重送信（日本時間の 1:30〜20:30 の間だけ）')
const homeC = must(await P[390].C.api.get('/api/staff/home'), 'home C')
ok('（前提）昨日の報告のないシフトが「前日までの報告漏れ」に出る', homeC.missed_reports && homeC.missed_reports.total >= 1 && homeC.missed_reports.shifts.some(x => x.shift_id === P[390].sidCy), homeC.missed_reports)

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w30staff-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let tabs
    for (let i = 0; i < 60 && !tabs; i++) { await wait(300); tabs = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = tabs && tabs.find(t => t.type === 'page')
    if (!pg) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = []; let dialogs = []; let acceptDialogs = false
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: acceptDialogs }) }
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name, full) => {
      if (!process.env.SHOT_DIR) return
      let clip
      if (full) { const h = await ev('document.scrollingElement.scrollHeight'); const w = await ev('document.documentElement.clientWidth'); clip = { x: 0, y: 0, width: w, height: Math.min(h, 6000), scale: 1 } }
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}) })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w30-ui-staff-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    const setWidth = (w) => send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: w < 600 })
    const pageNoScroll = async (label) => { const p = await ev(`({ sw: document.scrollingElement.scrollWidth, cw: document.documentElement.clientWidth })`); ok(label, p && p.sw <= p.cw + 1, p) }
    const openHome = async (cookie) => {
      // 別の人で開き直す（同じ URL への移動は読み直しにならないので、いったん空のページにする）
      await send('Page.navigate', { url: 'about:blank' })
      await wait(300)
      await as(cookie)
      await send('Page.navigate', { url: `${BASE}/staff#home` })
      return until(`!!document.getElementById('home-result') && !document.querySelector('#app .spin')`, 40000)
    }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    for (const w of [390, 1280]) {
      errors = []
      await setWidth(w)
      const { A, B, C, sidA, sidB, sidC } = P[w]
      // ----- C: 前日までの報告漏れ（1行）・「その他」の印 -----
      ok(`画面 ${w}px: C のホームが開く`, await openHome(C.ck))
      const missed = await ev(`(() => { const d = document.getElementById('missed-reports'); if (!d) return null
        const s = d.querySelector('summary'); const sh = document.getElementById('today-shift')
        return { tag: d.tagName, open: d.open, h: Math.round(s.getBoundingClientRect().height), text: s.textContent.replace(/\\s+/g, ' ').trim(), beforeShift: !sh || !!(d.compareDocumentPosition(sh) & Node.DOCUMENT_POSITION_FOLLOWING) } })()`)
      ok(`No.3 画面 ${w}px: 前日までの報告漏れは閉じた1行（「送る」）で、シフトのカードより上（今の位置）`, missed && missed.tag === 'DETAILS' && !missed.open && missed.h <= 48 && /報告漏れ/.test(missed.text) && /送る/.test(missed.text) && missed.beforeShift, missed)
      await ev(`document.querySelector('#missed-reports summary').click()`)
      ok(`No.3 画面 ${w}px: 1行を押すと、報告漏れの項目（追加の申請へのボタン）が出る`, await until(`document.getElementById('missed-reports').open && document.querySelectorAll('#missed-reports [data-action="openMissedReport"]').length > 0`, 3000))
      ok(`No.3 画面 ${w}px: 「その他」のタブの印に報告漏れの件数が足される`, await until(`(() => { const b = document.getElementById('nav-more-badge'); return !!b && !b.classList.contains('hidden') && Number(b.textContent) >= 1 && /報告漏れ/.test(b.getAttribute('aria-label') || '') })()`, 10000))
      if (w === 390) await shot('c-home-missed-390')

      if (sidC) {
        // ----- C: 遅刻の勤務開始を1回押すだけで送る → 黄色のカード（No.14・No.1）→ 押せない入店（No.2） -----
        dialogs = []; acceptDialogs = false
        await ev(`document.querySelector('#attendance-section .report-btn[data-type="work_start"]').click()`)
        const card = await until(`!!document.querySelector('#punch-result')`, 20000)
        ok(`No.14 画面 ${w}px: 写真の要らない報告（勤務開始）は確認の小窓なしで送る（前の報告を飛ばすときも）`, card && dialogs.length === 0, dialogs)
        const rc = await ev(`(() => { const c = document.getElementById('punch-result'); return c && { kind: c.dataset.kind, text: c.textContent.replace(/\\s+/g, ' '), late: !!c.querySelector('[data-action="punchLateReason"]'), top: document.getElementById('home-result').getBoundingClientRect().top < 200 } })()`)
        ok(`No.1 画面 ${w}px: 遅刻は黄色のカードで、時刻・「遅延」・「遅れた理由を送る」を出す（ホームの先頭）`, rc && rc.kind === 'warn' && /勤務開始 \d{2}:\d{2} を記録しました/.test(rc.text) && /遅延/.test(rc.text) && rc.late && rc.top, rc)
        const reps = await reportsOf(sidC)
        ok(`No.14 画面 ${w}px: 勤務開始が1件だけ記録される（遅刻）`, countOf(reps, 'work_start') === 1 && countOf(reps, 'check_in') === 0, reps)
        if (w === 390) await shot('c-after-late-390')
        // 押せない報告（後の勤務開始が済んだ入店）
        const lk = await ev(`(() => { const b = document.querySelector('#attendance-section .report-btn[data-type="check_in"]'); if (!b) return null; const cs = getComputedStyle(b)
          return { cls: b.className, disabled: b.disabled, aria: b.getAttribute('aria-disabled'), style: cs.borderTopStyle, lock: !!b.querySelector('.fa-lock'), op: cs.opacity } })()`)
        ok(`No.2 画面 ${w}px: 押せない入店は点線の枠と鍵の印（無効にせず aria-disabled・薄くしない）`, lk && /\blocked\b/.test(lk.cls) && !lk.disabled && lk.aria === 'true' && lk.style === 'dashed' && lk.lock && lk.op === '1', lk)
        await ev(`document.querySelector('#attendance-section .report-btn[data-type="check_in"]').click()`)
        const why = await ev(`(() => { const b = document.querySelector('#attendance-section .report-btn[data-type="check_in"]'); const n = b && b.nextElementSibling; return n && n.classList.contains('report-why') ? { text: n.textContent.replace(/\\s+/g, ' '), link: !!n.querySelector('a[href="#attendance"]') } : null })()`)
        ok(`No.2 画面 ${w}px: 押すとすぐ下に理由（後の報告が済んでいる）と打刻履歴へのボタンを出す`, why && /後の報告（勤務開始）が済んでいる/.test(why.text) && why.link, why)
        ok(`No.2 画面 ${w}px: 押せない入店を押しても送らない`, countOf(await reportsOf(sidC), 'check_in') === 0)
        if (w === 390) { await ev(`document.querySelector('#attendance-section .report-btn[data-type="check_in"]').scrollIntoView({ block: 'center' })`); await wait(200); await shot('c-locked-390') }
        // 遅れた理由を送る → 相談・連絡（遅刻・欠勤相談・そのシフト）
        await ev(`document.querySelector('[data-action="punchLateReason"]').click()`)
        ok(`No.1 画面 ${w}px: 「遅れた理由を送る」で相談・連絡を、遅刻・欠勤相談とそのシフトを選んで開く`, await until(`location.hash === '#consult' && !!document.getElementById('c-cat') && document.getElementById('c-cat').value === 'absence'`, 15000))
        // 打刻履歴の「これから」（No.5）: 休憩・勤務終了・退店は予定の終了前、起床〜入店は開始を過ぎて未報告
        await ev(`location.hash = 'attendance'`)
        const tl = await until(`!!document.querySelector('#att-body .card li')`, 20000)
        const rows = tl ? await ev(`[...document.querySelectorAll('#att-body .card')].slice(0, 1).flatMap(c => [...c.querySelectorAll(':scope > ul > li')].map(li => ({ label: li.children[0].textContent, val: li.children[1].textContent.trim(), btn: !!li.querySelector('button[data-action="attOpenRow"]') })))`) : null
        const row = (l) => (rows || []).find(r => r.label === l) || {}
        ok(`No.5 画面 ${w}px: 予定の時刻前（休憩入・勤務終了・退店）は「これから」で、申請のボタンを出さない`, rows && ['休憩入', '勤務終了', '退店報告'].every(l => /^これから/.test(row(l).val) && !row(l).btn), rows)
        ok(`No.5 画面 ${w}px: 時刻を過ぎた未報告（起床報告・入店報告）は今までどおり「未報告」と「追加申請」`, rows && ['起床報告', '入店報告'].every(l => /^未報告/.test(row(l).val) && row(l).btn), rows)
        if (w === 390) await shot('c-attendance-390', true)
        if (w === 1280) await shot('c-attendance-1280')
        await pageNoScroll(`画面 ${w}px: 打刻履歴が横にスクロールしない`)
        // ----- 日報の空欄（No.4） -----
        await ev(`location.hash = 'report/${sidC}'`)
        const rf = await until(`!!document.querySelector('#report-form .rpt-num')`, 20000)
        ok(`No.4 画面 ${w}px: 日報の画面が開く（件数の欄がある案件）`, rf)
        if (rf) {
          const sticky = await ev(`(() => { const b = document.querySelector('#report-form .report-submit-bar'); return b ? getComputedStyle(b).position : null })()`)
          ok(`No.4 画面 ${w}px: 提出のボタンは下に固定（sticky）`, sticky === 'sticky', sticky)
          if (w === 390) await shot('c-report-390')
          const n = await ev(`document.querySelectorAll('#report-form .rpt-num').length`)
          await ev(`document.getElementById('report-submit').click()`)
          await wait(400)
          const er = await ev(`(() => { const b = document.getElementById('report-errors'); const inv = [...document.querySelectorAll('#report-form .rpt-num.rpt-invalid')]
            return { shown: !b.classList.contains('hidden'), text: b.textContent.replace(/\\s+/g, ' '), links: b.querySelectorAll('[data-action="reportErrJump"]').length, zero: !!b.querySelector('[data-action="reportFillZero"]'), inv: inv.length,
              msgs: inv.filter(x => { const m = x.closest('div.flex').parentElement.querySelector('.rpt-err'); return m && !m.classList.contains('hidden') && /＊未入力です/.test(m.textContent) }).length, aria: inv.every(x => x.getAttribute('aria-invalid') === 'true') } })()`)
          ok(`No.4 画面 ${w}px: 空欄のまま送ると、全部の欄に赤い枠と「＊未入力です」、先頭に件数・欄へのリンク・「空欄を0にする」を出す`, er && er.shown && new RegExp(`未入力が${n}件あります`).test(er.text) && er.links === n && er.zero && er.inv === n && er.msgs === n && er.aria, { n, er })
          ok(`No.4 画面 ${w}px: 空欄のときは日報を送らない（日報の画面のまま）`, (await ev(`location.hash === '#report/${sidC}' && !!document.getElementById('report-form')`)))
          if (w === 390) await shot('c-report-empty-390')
          await ev(`document.querySelector('#report-errors [data-action="reportFillZero"]').click()`)
          const cl = await ev(`({ hidden: document.getElementById('report-errors').classList.contains('hidden'), inv: document.querySelectorAll('#report-form .rpt-invalid').length, zero: [...document.querySelectorAll('#report-form .rpt-num')].every(x => x.value === '0') })`)
          ok(`No.4 画面 ${w}px: 「空欄を0にする」で0が入り、印とまとめが消える（入力した値は消さない）`, cl && cl.hidden && cl.inv === 0 && cl.zero, cl)
        }
        await pageNoScroll(`画面 ${w}px: 日報の画面が横にスクロールしない`)
      } else skip(`画面 ${w}px: 遅刻・押せない報告・これから・日報（日本時間の 1:30〜20:30 の間だけ）`)

      if (sidB) {
        // ----- B: 固定のボタン（起床）を1回押すだけで送る・送った直後は押せない・二度押ししない（No.10・No.14・No.1） -----
        ok(`画面 ${w}px: B のホームが開く`, await openHome(B.ck))
        const bar = await ev(`(() => { const b = document.querySelector('#home-next-bar .next-bar-btn'); if (!b) return null; const r = b.getBoundingClientRect(), nav = document.getElementById('bottom-nav').getBoundingClientRect()
          return { type: b.dataset.type, text: b.textContent.replace(/\\s+/g, ' ').trim(), gap: Math.round(nav.top - r.bottom), pos: getComputedStyle(document.getElementById('home-next-bar')).position, next: document.querySelector('#attendance-section .report-btn.next')?.dataset.type, body: document.body.classList.contains('has-next-bar') } })()`)
        const expectB = 'wake_up'
        ok(`No.10 画面 ${w}px: 次の報告（起床）を下のタブのすぐ上に固定して出し、一覧の「次の報告」と同じ`, bar && bar.type === expectB && bar.pos === 'fixed' && bar.gap >= 0 && bar.gap <= 40 && bar.next === expectB && bar.body && /すぐ送ります/.test(bar.text), bar)
        if (w === 390) await shot('b-home-bar-390')
        if (w === 1280) await shot('b-home-bar-1280')
        dialogs = []; acceptDialogs = false
        // 2回続けて押す（2回目は送っている間・送った直後なので受け付けない）
        await ev(`document.querySelector('#home-next-bar .next-bar-btn').click()`)
        await wait(150)
        await ev(`(() => { const b = document.querySelector('#home-next-bar .next-bar-btn'); if (b) b.click(); return true })()`)
        const sent = await until(`!!document.querySelector('#punch-result')`, 20000)
        ok(`No.14 画面 ${w}px: 固定のボタンを1回押すだけで送る（確認の小窓なし）`, sent && dialogs.length === 0, dialogs)
        const after = await ev(`(() => { const b = document.querySelector('#home-next-bar .next-bar-btn'); const c = document.getElementById('punch-result'); return { type: b && b.dataset.type, disabled: b && b.disabled, kind: c && c.dataset.kind, text: c && c.textContent.replace(/\\s+/g, ' ') } })()`)
        ok(`No.1 画面 ${w}px: 送った直後、ホームの先頭に緑のカードで記録した時刻と次の報告を出す`, after.kind === 'ok' && new RegExp(`起床報告 \\d{2}:\\d{2} を記録しました`).test(after.text) && /次は/.test(after.text), after)
        ok(`No.10 画面 ${w}px: 送った直後は、次の報告に変わった固定のボタンを少しの間押せない`, after.disabled === true && after.type && after.type !== expectB, after)
        if (w === 390) await shot('b-after-press-390')
        await ev(`(() => { const b = document.querySelector('#home-next-bar .next-bar-btn'); if (b) b.click(); return true })()`) // 押せない間に押す
        ok(`No.10 画面 ${w}px: 少したつと押せるようになる`, await until(`(() => { const b = document.querySelector('#home-next-bar .next-bar-btn'); return !!b && !b.disabled })()`, 4000))
        const repB = await reportsOf(sidB)
        ok(`No.14 画面 ${w}px: 二度押し・押せない間に押しても、記録は押した報告の1件だけ`, countOf(repB, expectB) === 1 && countOf(repB, 'departure') === 0, repB)
        if (w === 390) {
          // 電波がない場所で押す → 端末に保存 → 電波が戻ったら1件だけ送る（打刻の送り方は今までどおり）
          await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
          await ev(`document.querySelector('#home-next-bar .next-bar-btn').click()`)
          const queued = await until(`!!document.getElementById('punch-status') && /まだ送れていない報告/.test(document.getElementById('home-next-bar') ? document.getElementById('home-next-bar').textContent + document.getElementById('punch-status').textContent : document.getElementById('punch-status').textContent)`, 30000)
          ok('画面 390px: 電波がないときは端末に保存し、ホームと固定のボタンの上に「まだ送れていない報告」を出す', queued)
          await shot('b-offline-390')
          await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
          await ev(`window.dispatchEvent(new Event('online')); true`)
          const flushed = await until(`!document.getElementById('punch-status')`, 60000)
          const rep2 = await reportsOf(sidB)
          ok('画面 390px: 電波が戻ると送り、出発の記録は1件だけ（二重記録0件）', flushed && countOf(rep2, 'departure') === 1, rep2)
        }
        await pageNoScroll(`画面 ${w}px: B のホームが横にスクロールしない`)
      } else skip(`画面 ${w}px: 固定のボタン（日本時間の 1:30〜20:30 の間だけ）`)

      if (sidA) {
        // ----- A: 入店まで20分 → 起床・出発が未報告でも入店を出す（No.10）。押すと今の流れ（確認の小窓→写真の画面）。位置情報の案内（No.12） -----
        ok(`画面 ${w}px: A のホームが開く`, await openHome(A.ck))
        const bar = await ev(`(() => { const b = document.querySelector('#home-next-bar .next-bar-btn'); const sk = document.getElementById('next-bar-skip'); return b ? { type: b.dataset.type, text: b.textContent.replace(/\\s+/g, ' ').trim(), skip: sk && sk.textContent.trim() } : null })()`)
        ok(`No.10 画面 ${w}px: 入店の時刻が30分以内なら、起床・出発が未報告でも固定のボタンは入店で、飛ばす報告を灰色の1行で出す`, bar && bar.type === 'check_in' && /入店報告をする/.test(bar.text) && /写真/.test(bar.text) && /起床報告・出発報告は押さずに進みます/.test(bar.skip || ''), bar)
        if (w === 390) await shot('a-home-bar-390')
        // 位置情報: 許可されていない → 時間切れ → 取れない（ページの中で getCurrentPosition を差し替える）
        await ev(`(() => { window.__geoCode = 1; navigator.geolocation.getCurrentPosition = (ok, ng) => setTimeout(() => ng({ code: window.__geoCode, message: 'test' }), 50); return true })()`)
        dialogs = []; acceptDialogs = false
        await ev(`document.querySelector('#home-next-bar .next-bar-btn').click()`)
        await wait(500)
        ok(`No.11 見送り 画面 ${w}px: 固定のボタンで入店を押すと、今の流れのとおり飛ばす報告の確認の小窓を出す（キャンセルで何もしない）`, dialogs.length === 1 && /起床報告・出発報告 が未報告です/.test(dialogs[0]) && !(await ev(`!!document.getElementById('photo-area')`)), dialogs)
        acceptDialogs = true; dialogs = []
        await ev(`document.querySelector('#home-next-bar .next-bar-btn').click()`)
        const photo = await until(`!!document.getElementById('photo-area') && /カメラで撮影/.test(document.getElementById('photo-area').textContent)`, 5000)
        ok(`No.11 見送り 画面 ${w}px: 確認のあと、今までどおり写真の画面（カメラで撮影・アルバムから選択）を開く`, photo && dialogs.length === 1, dialogs)
        const g1 = await until(`document.querySelector('#geo-error')?.dataset.geoErr === 'denied'`, 5000)
        const gd = await ev(`(() => { const g = document.getElementById('geo-error'); return g && { text: g.textContent.replace(/\\s+/g, ' '), retry: !!g.querySelector('[data-action="photoRetryPosition"]') } })()`)
        ok(`No.12 画面 ${w}px: 許可されていないときは、何が起きたか・なぜか・どうするか、iPhone と Android の手順、「もう一度取る」を出す`, g1 && /位置情報を使えません/.test(gd.text) && /許可されていません/.test(gd.text) && /iPhone:/.test(gd.text) && /Android:/.test(gd.text) && gd.retry, gd)
        if (w === 390) await shot('a-geo-denied-390')
        await ev(`window.__geoCode = 3; document.querySelector('[data-action="photoRetryPosition"]').click(); true`)
        const g3 = await until(`document.querySelector('#geo-error')?.dataset.geoErr === 'timeout' && /時間切れ/.test(document.getElementById('geo-error').textContent) && !/iPhone:/.test(document.getElementById('geo-error').textContent)`, 5000)
        ok(`No.12 画面 ${w}px: 「もう一度取る」で取り直し、時間切れの案内に変わる`, g3)
        if (w === 390) await shot('a-geo-timeout-390')
        await ev(`window.__geoCode = 2; document.querySelector('[data-action="photoRetryPosition"]').click(); true`)
        ok(`No.12 画面 ${w}px: 取れないときの案内（位置情報がオフ・GPS が届かない）`, await until(`document.querySelector('#geo-error')?.dataset.geoErr === 'unavailable' && /取れませんでした/.test(document.getElementById('geo-error').textContent)`, 5000))
        await ev(`window.__geoOk = true; navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok({ coords: { latitude: 35.69, longitude: 139.7, accuracy: 10 }, timestamp: Date.now() }), 50); document.querySelector('[data-action="photoRetryPosition"]').click(); true`)
        ok(`No.12 画面 ${w}px: 取れたら「位置情報を取得しました」に変わる`, await until(`!document.getElementById('geo-error') && /位置情報を取得しました/.test(document.getElementById('photo-pos').textContent)`, 5000))
        await ev(`closeModal(); true`)
        acceptDialogs = false
        ok(`画面 ${w}px: 入店は送っていない（写真の画面を閉じた）`, countOf(await reportsOf(sidA), 'check_in') === 0)
        await pageNoScroll(`画面 ${w}px: A のホームが横にスクロールしない`)
      } else skip(`画面 ${w}px: 入店の固定のボタン・位置情報の案内（日本時間の 1:30〜20:30 の間だけ）`)

      ok(`画面 ${w}px: スクリプトのエラーがない`, errors.length === 0, errors)
    }
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
