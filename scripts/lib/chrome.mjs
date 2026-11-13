// テストで使うヘッドレス Chrome の起動（Sprint 26 #9980）。
//   1) デバッグ用のポートは空いているものを使う（freePort。ほかのテスト・開発サーバーとポートを取り合わない）
//   2) CDN（https://cdn.jsdelivr.net/npm/<名前>@<版>/<ファイル>）の読み込みを、node_modules にある同じ版のファイルで返す
//      （CDP の Fetch で横取りする。外のネットワークに頼らない。SRI は Chrome がそのまま確かめる）。
//      jsDelivr がその場で縮めて作る .min.js（npm の包みに無いファイル。qrcode-generator・jsqr）は、scripts/lib/cdn-min/ に置いた写し（/ を __ にした名前）で返す。
//      同じ版がどちらにも無いときだけ CDN から読み、最初に1回だけ知らせる（npm ci で devDependencies を入れると直る）
// 使い方（各テストの browserChecks の中）:
//   const PORT = await (await import('./lib/chrome.mjs')).freePort()
//   const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, ...], { stdio: 'ignore' })
// 環境変数 CDN_OFFLINE=0 で横取りをやめる（CDN から読む）。
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules')
const CDN_MIN = join(dirname(fileURLToPath(import.meta.url)), 'cdn-min')
const CDN_RE = /^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/([^?#]+)/
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.map': 'application/json' }
const warned = new Set()
const wait = ms => new Promise(r => setTimeout(r, ms))

// 空いているポート（OS に選ばせる）
export function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
  })
}

// CDN の URL に対応する手元のファイル（node_modules の同じ名前・同じ版、なければ cdn-min の写し）。無ければ null と理由
export function localCdnFile(url) {
  const m = CDN_RE.exec(url)
  if (!m) return { file: null, why: 'CDN の形でない' }
  const [, name, ver, rel] = m
  // 写しは1つのフォルダに、/ を __ にした名前で置く（.gitignore の dist/ に当たらないように）
  const flat = `${name}@${ver}/${decodeURIComponent(rel)}`.replace(/\//g, '__')
  if (!/[\\:]|\.\./.test(flat) && existsSync(join(CDN_MIN, flat))) return { file: join(CDN_MIN, flat), why: '' }
  const pkgDir = join(NODE_MODULES, ...name.split('/'))
  let have = null
  try { have = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version } catch { }
  if (have !== ver) return { file: null, why: have ? `node_modules の ${name} は ${have}（CDN は ${ver}）` : `node_modules に ${name} がない` }
  const file = resolve(pkgDir, decodeURIComponent(rel))
  if (!file.startsWith(pkgDir + sep) || !existsSync(file)) return { file: null, why: `${name}@${ver} に ${rel} がない` }
  return { file, why: '' }
}

// 返す中身。cdn-min の写しは、Windows の git（core.autocrlf）で改行が CRLF になっていても元の LF に戻す（SRI のハッシュを合わせる）
export function cdnBody(file) {
  const buf = readFileSync(file)
  return file.startsWith(CDN_MIN + sep) ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf
}

// Chrome を起動し、CDN の横取りを用意してから返す（戻り値は spawn の ChildProcess。今までどおり chrome.kill() で止める）
export async function launchChrome(chromePath, args, opts = {}) {
  const chrome = spawn(chromePath, args, opts)
  if (process.env.CDN_OFFLINE === '0') return chrome
  const port = Number((args.find(a => a.startsWith('--remote-debugging-port=')) || '').split('=')[1])
  if (!port) return chrome
  let ver = null
  for (let i = 0; i < 100 && !ver && chrome.exitCode === null; i++) {
    await wait(150)
    ver = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()).catch(() => null)
  }
  if (!ver || !ver.webSocketDebuggerUrl) return chrome   // 起動しなかったときは、今までどおりテストの側で「起動できない」を出す
  try { await interceptCdn(ver.webSocketDebuggerUrl, chrome) } catch (e) { console.log(`（注意）CDN の横取りを用意できませんでした: ${e.message}`) }
  return chrome
}

// ブラウザ全体のセッションで、開いているページ・これから開くページ（iframe・worker も）に Fetch を入れる
async function interceptCdn(wsUrl, chrome) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket に接続できない')) })
  chrome.once('exit', () => { try { ws.close() } catch { } })
  let id = 0
  const pend = new Map()
  const send = (method, params = {}, sessionId) => new Promise(res => {
    const i = ++id
    pend.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const ready = new Set()
  const AUTO = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data)
    if (m.id) { const r = pend.get(m.id); pend.delete(m.id); if (r) r(m); return }
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId, type = m.params.targetInfo.type
      if (type !== 'tab') await send('Fetch.enable', { patterns: [{ urlPattern: 'https://cdn.jsdelivr.net/npm/*', requestStage: 'Request' }] }, sid)
      // ページの中の iframe・worker、タブの中のページにも入れる
      await send('Target.setAutoAttach', AUTO, sid)
      ready.add(m.params.targetInfo.targetId)
      await send('Runtime.runIfWaitingForDebugger', {}, sid)
      return
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params
      const sid = m.sessionId
      const { file, why } = localCdnFile(request.url)
      if (!file) {
        if (!warned.has(why)) { warned.add(why); console.log(`（注意）CDN を node_modules で返せないので、ネットワークから読みます: ${why}。npm ci で入ります`) }
        await send('Fetch.continueRequest', { requestId }, sid)
        return
      }
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: TYPES[extname(file)] || 'application/octet-stream' },
          { name: 'Access-Control-Allow-Origin', value: '*' },  // crossorigin="anonymous" と SRI のため
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: cdnBody(file).toString('base64'),
      }, sid)
    }
  }
  await send('Target.setAutoAttach', { ...AUTO, filter: [{ type: 'browser', exclude: true }, { type: 'page', exclude: true }, {}] })  // ページはタブの中でつなぐ
  // 起動したときの about:blank のページに Fetch が入るまで待つ（テストが最初に開く前に）
  for (let i = 0; i < 40; i++) {
    const { result } = await send('Target.getTargets')
    const pages = (result?.targetInfos || []).filter(t => t.type === 'page')
    if (pages.length && pages.every(t => ready.has(t.targetId))) return
    await wait(100)
  }
  throw new Error('ページに接続できない')
}
