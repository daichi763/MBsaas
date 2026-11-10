// w23-server-lib（Sprint 23 #9955）の確認: サーバーの日時・ハッシュの小さな関数を src/lib/time.ts・src/lib/hash.ts に1つずつ置く
//   - 関数の単体の確認（日付の境目・月末・年末・うるう年・日本時間の 0 時の前後・前の書き方と同じ結果になること）
//   - 複製が残っていないことをソースで確かめる（nowJST などの定義・+9時間の式・SHA-256・乱数の16進）
//   - API で、日時・ハッシュを使う所が今までどおり動く（ログイン・セッション・お知らせの日時と重複の判定・今日の日付・エラーの日別の件数）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8921 --persist-to <保存先> で起動していること（本番には接続しない）
// 実行: BASE=http://127.0.0.1:8921 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w23-server-lib.mjs
//   PERSIST があるときだけ、ローカルの D1 に旧形式（ソルトなし SHA-256）のパスワードを直接書いて、ログインできるかを確かめる（wrangler d1 execute は --local のみ）
//   src/lib/time.ts・hash.ts は Node の型の除去（Node 22.18 以降）でそのまま読み込む
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:8921'
const PERSIST = process.env.PERSIST || ''
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const src = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n')

// ---------- 単体: src/lib/time.ts ----------
const T = await import(new URL('../src/lib/time.ts', import.meta.url))
const H = await import(new URL('../src/lib/hash.ts', import.meta.url))
{
  const { jstOf, nowJST, todayJST, addDays, dayDiff, isDate } = T
  // 前の書き方（各ファイルにあった複製）。新しい関数と同じ結果になることを確かめる
  const old = {
    nowJST: (now) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    nowJSTRetention: (now) => new Date(now + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    todayJST: (now) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10),
    minute: (now) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    ago: (now, ms) => new Date(now + 9 * 3600 * 1000 - ms).toISOString().slice(0, 19).replace('T', ' '),
    addMinutesJST: (now, m) => new Date(now + (9 * 60 + m) * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    jstDate: (now, d) => new Date(now + 9 * 3600 * 1000 - d * 86400000).toISOString().slice(0, 10),
  }
  const realNow = Date.now
  const at = (iso, fn) => { const ms = Date.parse(iso); Date.now = () => ms; try { return fn(ms) } finally { Date.now = realNow } }
  // 日本時間の 0 時の前後（UTC 14:59:59 → 23:59:59、UTC 15:00:00 → 翌日 0:00:00）
  ok('nowJST: UTC 14:59:59.999 は日本時間の同じ日の 23:59:59', at('2026-11-10T14:59:59.999Z', () => nowJST()) === '2026-11-10 23:59:59')
  ok('nowJST: UTC 15:00:00 は日本時間の翌日の 00:00:00', at('2026-11-10T15:00:00.000Z', () => nowJST()) === '2026-11-11 00:00:00')
  ok('todayJST: 日本時間の 0 時の直前・直後で日付が変わる', at('2026-11-10T14:59:59.999Z', () => todayJST()) === '2026-11-10' && at('2026-11-10T15:00:00.000Z', () => todayJST()) === '2026-11-11')
  ok('todayJST: 月末・年末の 0 時（日本時間の 2026-12-31 24:00 は 2027-01-01）', at('2026-12-31T15:00:00Z', () => todayJST()) === '2027-01-01' && at('2026-12-31T14:59:59Z', () => todayJST()) === '2026-12-31')
  ok('todayJST: うるう年の 2/29（日本時間）', at('2028-02-28T15:00:00Z', () => todayJST()) === '2028-02-29' && at('2028-02-29T15:00:00Z', () => todayJST()) === '2028-03-01')
  ok('nowJST(offsetMs): 負の値は過去・正の値は先（0 時をまたぐ）', at('2026-11-10T15:00:30Z', () => nowJST(-60 * 1000)) === '2026-11-10 23:59:30' && at('2026-11-10T14:59:30Z', () => nowJST(60 * 1000)) === '2026-11-11 00:00:30')
  ok('jstOf: エポックミリ秒を日本時間にする', jstOf(Date.parse('2026-02-28T15:00:00Z')) === '2026-03-01 00:00:00' && jstOf(0) === '1970-01-01 09:00:00')
  // 前の書き方と同じ結果か（境目の前後と、ばらばらの時刻）
  const samples = ['2026-11-10T14:59:59.999Z', '2026-11-10T15:00:00.000Z', '2026-12-31T15:00:00Z', '2028-02-28T15:00:00Z', '2027-02-28T14:59:59Z', '2026-03-31T15:00:00.001Z']
    .map(s => Date.parse(s))
  for (let i = 0; i < 200; i++) samples.push(Date.UTC(2024, 0, 1) + Math.floor(Math.random() * 6 * 365 * 86400000))
  const diffs = []
  for (const ms of samples) {
    Date.now = () => ms
    try {
      if (nowJST() !== old.nowJST(ms) || nowJST() !== old.nowJSTRetention(ms)) diffs.push(['nowJST', ms])
      if (todayJST() !== old.todayJST(ms)) diffs.push(['todayJST', ms])
      if (nowJST().slice(0, 16) !== old.minute(ms)) diffs.push(['minute', ms])
      if (nowJST(-90 * 60 * 1000) !== old.ago(ms, 90 * 60 * 1000)) diffs.push(['ago', ms])
      if (nowJST(-24 * 3600 * 1000) !== old.ago(ms, 24 * 3600 * 1000)) diffs.push(['dayAgo', ms])
      if (nowJST(-15 * 60 * 1000) !== old.addMinutesJST(ms, -15)) diffs.push(['addMinutesJST', ms])
      if (nowJST(30 * 86400 * 1000) !== old.ago(ms, -30 * 86400 * 1000)) diffs.push(['daysLater', ms])
      for (const d of [0, 1, 13]) if (addDays(todayJST(), -d) !== old.jstDate(ms, d)) diffs.push(['jstDate', ms, d])
      if (jstOf(ms) !== old.nowJST(ms)) diffs.push(['jstOf', ms])
    } finally { Date.now = realNow }
  }
  ok(`前の書き方と同じ結果（境目の 6 個とばらばらの 200 個の時刻。nowJST・todayJST・分まで・n 分前・n 日前・n 日後・jstOf）`, !diffs.length, diffs.slice(0, 5))

  // addDays: 月末・年末・うるう年・負の値
  const addCases = [
    ['2026-01-31', 1, '2026-02-01'], ['2026-02-28', 1, '2026-03-01'], ['2028-02-28', 1, '2028-02-29'], ['2028-02-29', 1, '2028-03-01'],
    ['2027-02-28', 1, '2027-03-01'], ['2026-12-31', 1, '2027-01-01'], ['2027-01-01', -1, '2026-12-31'], ['2024-03-01', -1, '2024-02-29'],
    ['2026-03-01', -1, '2026-02-28'], ['2026-11-10', 0, '2026-11-10'], ['2026-11-10', 30, '2026-12-10'], ['2026-11-10', -365, '2025-11-10'],
    ['2100-02-28', 1, '2100-03-01'], ['2000-02-28', 1, '2000-02-29'],
  ]
  const addBad = addCases.filter(([d, n, want]) => addDays(d, n) !== want).map(([d, n, want]) => ({ d, n, want, got: addDays(d, n) }))
  ok('addDays: 月末・年末・うるう年（2028・2000 はうるう年、2027・2100 は違う）・負の値・0', !addBad.length, addBad)
  // dayDiff
  const diffCases = [
    ['2028-02-28', '2028-03-01', 2], ['2027-02-28', '2027-03-01', 1], ['2026-12-31', '2027-01-01', 1], ['2027-01-01', '2026-12-31', -1],
    ['2026-11-10', '2026-11-10', 0], ['2026-01-01', '2027-01-01', 365], ['2028-01-01', '2029-01-01', 366], ['2026-03-31', '2026-03-01', -30],
  ]
  const diffBad = diffCases.filter(([a, b, want]) => dayDiff(a, b) !== want).map(([a, b, want]) => ({ a, b, want, got: dayDiff(a, b) }))
  ok('dayDiff: うるう年・年末・逆の順（負の値）・同じ日', !diffBad.length, diffBad)
  ok('dayDiff と addDays が往復で合う（ばらばらの 100 組）', Array.from({ length: 100 }, () => {
    const a = new Date(Date.UTC(2024, 0, 1) + Math.floor(Math.random() * 2000) * 86400000).toISOString().slice(0, 10)
    const n = Math.floor(Math.random() * 1500) - 750
    return dayDiff(a, addDays(a, n)) === n
  }).every(Boolean))
  // isDate（形だけを見る。前の複製と同じ）
  ok('isDate: YYYY-MM-DD の形だけ true', isDate('2026-11-10') && isDate('2028-02-29') && isDate('2026-02-30')
    && !isDate('2026-1-10') && !isDate('2026/11/10') && !isDate('2026-11-10 00:00:00') && !isDate('') && !isDate(null) && !isDate(undefined) && !isDate(20261110) && !isDate(' 2026-11-10'))
}

// ---------- 単体: src/lib/hash.ts ----------
{
  const { sha256, randomHex, toHex } = H
  const nodeSha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
  ok('sha256: 既知の値（"abc"・空文字）', await sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    && await sha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  const texts = ['pass1234', '日本語のパスワード', '!nologin!' + 'a'.repeat(64), 'ip|203.0.113.5', 'account|sample|admin', '😀絵文字']
  ok('sha256: Node の crypto と同じ（日本語・絵文字を含む。小文字の16進64文字）', (await Promise.all(texts.map(async t => (await sha256(t)) === nodeSha(t)))).every(Boolean)
    && /^[0-9a-f]{64}$/.test(await sha256('x')))
  ok('toHex: 0 埋めの小文字16進', toHex(new Uint8Array([0, 1, 15, 16, 255])) === '00010f10ff' && toHex(new Uint8Array([])) === '')
  const hx = [randomHex(32), randomHex(32), randomHex(6), randomHex(9)]
  ok('randomHex: 長さは bytes × 2・小文字16進・毎回違う', hx[0].length === 64 && hx[2].length === 12 && hx[3].length === 18 && hx.every(h => /^[0-9a-f]+$/.test(h)) && hx[0] !== hx[1])
}

// ---------- ソース: 複製が残っていない ----------
{
  const files = []
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(relative(ROOT, p).replace(/\\/g, '/')) } }
  walk(join(ROOT, 'src'))
  const LIB = ['src/lib/time.ts', 'src/lib/hash.ts']
  const hits = (re) => files.filter(f => !LIB.includes(f)).flatMap(f => src(f).split('\n').map((l, i) => re.test(l) ? `${f}:${i + 1}` : null).filter(Boolean))
  const defs = hits(/^\s*(export )?(async )?(function|const|let|var) (nowJST|todayJST|addDays|dayDiff|isDate|sha256|toHex|jstOf|randHex)\b/)
  ok('nowJST・todayJST・addDays・dayDiff・isDate・jstOf・sha256・toHex を src/lib/time.ts・hash.ts の外で定義していない', !defs.length, defs)
  const jst = hits(/9 \* 3600 \* 1000|9 \* 60 \* 60 \* 1000|9 \* 3600e3|\(9 \* 60 \+|32400000/)
  ok('日本時間の +9 時間の式は src/lib/time.ts だけ', !jst.length, jst)
  const dig = hits(/crypto\.subtle\.digest\(\s*'SHA-256'/)
  ok('SHA-256 の計算は src/lib/hash.ts だけ', !dig.length, dig)
  const hex = hits(/toString\(16\)\.padStart\(2/)
  ok('バイト列の16進の書き方は src/lib/hash.ts だけ', !hex.length, hex)
  const time = src('src/lib/time.ts'), hash = src('src/lib/hash.ts')
  ok('time.ts が nowJST・todayJST・addDays・dayDiff・isDate・jstOf を export している', ['nowJST', 'todayJST', 'addDays', 'dayDiff', 'jstOf'].every(n => new RegExp(`export function ${n}\\b`).test(time)) && /export const isDate\b/.test(time))
  ok('hash.ts が sha256・randomHex・toHex を export している', ['sha256', 'randomHex', 'toHex'].every(n => new RegExp(`export (async )?function ${n}\\b`).test(hash)))
  ok('auth.ts の sha256Hex・hashToken は hash.ts の sha256（呼び出し元の名前は残す）', /import \{ sha256 \} from '\.\/hash'/.test(src('src/lib/auth.ts')) && /export const sha256Hex = sha256\b/.test(src('src/lib/auth.ts')) && /export const hashToken = sha256Hex\b/.test(src('src/lib/auth.ts')))
  ok('shift-time.ts は addDays を time.ts から使う（自分では定義しない）', /import \{ addDays \} from '\.\/time'/.test(src('src/lib/shift-time.ts')))
  const fromShiftTime = files.filter(f => /import \{[^}]*\baddDays\b[^}]*\} from '[./]*(lib\/)?shift-time'/.test(src(f)))
  ok('addDays を shift-time から import している所がない（time.ts にそろえる）', !fromShiftTime.length, fromShiftTime)
  ok('staff-pay-notify.ts は nowJST を export しない（time.ts から使う）', !/export function nowJST/.test(src('src/lib/staff-pay-notify.ts')) && /import \{[^}]*nowJST[^}]*\} from '\.\/lib\/time'/.test(src('src/staff-pay.ts')))
}

// ---------- API: 日時・ハッシュを使う所が今までどおり ----------
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  return { status: r.status, cookie }
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const todayLocal = () => jstNow().slice(0, 10)
const secOf = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z') / 1000
const PFX = 'W23L' + Date.now().toString(36).slice(-4).toUpperCase()

// ログイン・セッション（セッションのトークンは hashToken = sha256 で保存して照合する）
const la = await login('sample', 'admin')
ok('ログインできる（パスワードの照合）', la.status === 200 && !!la.cookie, la.status)
const admin = client(la.cookie)
const me = await admin.get('/api/auth/me')
ok('セッションの Cookie で /api/auth/me が開ける（トークンのハッシュの照合）', me.status === 200 && me.data?.user?.user_code === 'admin', { status: me.status })
const bad = await login('sample', 'admin', 'wrong-password')
ok('違うパスワードではログインできない', bad.status === 401 || bad.status === 400 || bad.status === 429, bad.status)
const hqLogin = await login('sample', 'hq')
const hq = client(hqLogin.cookie)

// お知らせ: 配信の日時（nowJST）と、直前の同じ内容の重複の判定（nowJST(-秒)）
{
  const before = jstNow()
  const title = `${PFX} 日時の確認`
  const r1 = await admin.post('/api/admin/notices', { title, body: '本文', target_type: 'all', importance: 'normal', mode: 'publish' })
  ok('お知らせを配信できる', r1.status === 200, r1.data)
  const list = must(await admin.get(`/api/admin/notices?q=${encodeURIComponent(PFX)}`), 'notices')
  const n = (list.notices || list.items || []).find(x => x.title === title)
  const pub = n?.published_at || n?.created_at
  ok('配信の日時は日本時間の今（YYYY-MM-DD HH:MM:SS・前後 2 分以内）', !!pub && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(pub) && Math.abs(secOf(pub) - secOf(before)) <= 120, { pub, before })
  const r2 = await admin.post('/api/admin/notices', { title, body: '本文', target_type: 'all', importance: 'normal', mode: 'publish' })
  ok('直前に同じ内容を配信したら重複として受け付けない（n 秒前の日本時間の比較）', r2.status === 409 || (r2.status === 200 && (r2.data?.duplicate || r2.data?.notice_id === r1.data?.notice_id)), r2)
}

// 今日の日付（todayJST）と、n 日後の日付（addDays）
{
  const d = must(await admin.get('/api/admin/staff-requests/documents'), 'documents')
  const t = todayLocal()
  ok('書類の期限の画面の today は日本時間の今日', d.today === t || d.today === T.addDays(t, -1) || d.today === T.addDays(t, 1), { got: d.today, want: t })
  ok('書類の期限の warn_days が数', Number.isInteger(d.warn_days) && d.warn_days > 0, d.warn_days)
  const off = must(await hq.get('/api/hq/offboarding'), 'hq offboarding')
  ok('本部の解約の画面の today は日本時間の今日', off.today === d.today, { off: off.today, docs: d.today })
}

// 本部のエラーの日別の件数（jstDate = addDays(todayJST(), -n)）: 14 日が続いていて、最後が今日
{
  const e = must(await hq.get('/api/hq/errors'), 'hq errors')
  const days = (e.trend || []).map(x => x.day)
  const t = todayLocal()
  const consecutive = days.every((d, i) => i === 0 || T.dayDiff(days[i - 1], d) === 1)
  ok('エラーの日別の件数: 14 日分・1 日ずつ続く・最後が今日（日本時間）', days.length === 14 && consecutive && (days[13] === t || days[13] === T.addDays(t, -1) || days[13] === T.addDays(t, 1)), days)
  ok('エラーの日別の件数: 日付は YYYY-MM-DD', days.every(d => T.isDate(d)), days)
}

// 日付の入力の確かめ（isDate）: シフトの希望の一覧の from が日付でないときは今日から
{
  const r = await admin.get('/api/admin/shift-requests?from=not-a-date')
  ok('日付でない from でも 500 にならない（isDate で今日にする）', r.status === 200, r.status)
  const r2 = await admin.get(`/api/admin/shift-requests?from=${todayLocal()}`)
  ok('日付の from を受け付ける', r2.status === 200, r2.status)
}

// 旧形式（ソルトなし SHA-256 の16進）のパスワードでログインできる（auth.ts の sha256Hex = hash.ts の sha256）
if (PERSIST) {
  const SQL_DIR = mkdtempSync(join(tmpdir(), 'w23lib-'))
  let seq = 0
  const sql = (command) => {
    const file = join(SQL_DIR, `q${++seq}.sql`)
    writeFileSync(file, command)
    for (let i = 1; ; i++) {
      try {
        const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
        const j = JSON.parse(out); return j[j.length - 1].results
      } catch (e) { if (i >= 3) throw e }
    }
  }
  const code = `${PFX}L`
  const cr = await admin.post('/api/admin/staff', { user_code: code, name: `${PFX} 旧形式`, password: 'pass1234' })
  ok('スタッフを追加できる', cr.status === 200, cr.data)
  const legacyPass = 'Legacy-Pass-9955'
  const legacyHash = createHash('sha256').update(legacyPass, 'utf8').digest('hex')
  sql(`UPDATE users SET password_hash = '${legacyHash}' WHERE company_id = 1 AND user_code = '${code}'`)
  const l1 = await login('sample', code, legacyPass)
  ok('旧形式の SHA-256 のパスワードでログインできる', l1.status === 200 && !!l1.cookie, l1.status)
  const row = sql(`SELECT password_hash FROM users WHERE company_id = 1 AND user_code = '${code}'`)[0]
  ok('ログインのあと、新しい形式（pbkdf2）に作り直される', /^pbkdf2\$/.test(String(row?.password_hash)), row)
  const l2 = await login('sample', code, legacyPass)
  ok('作り直したあとも同じパスワードでログインできる', l2.status === 200, l2.status)
} else console.log('SKIP  旧形式の SHA-256 のパスワードのログイン（PERSIST が無いため）')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
