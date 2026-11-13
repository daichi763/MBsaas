// 見た目のトークン化（Sprint 26 #9977）: 画面の JS・HTML に直書きした色・文字の大きさのクラスを、トークン（CSS 変数）を見るクラスへ置き換える。
// 何度流しても同じ結果になる（置き換え済みの所はそのまま）。ほかの作業で直書きのクラスが増えたら、もう一度流す。
//   usage: node scripts/tokens-codemod.mjs           置き換える
//          node scripts/tokens-codemod.mjs --check   置き換えが残っているファイルを出して終了コード 1（ファイルは変えない）
//          node scripts/tokens-codemod.mjs --order   置き換える前に流す。同じ要素に付いた同じ種類の色のクラスで、効く方が入れ替わる所を出す
//                                                     （Tailwind はクラス名の文字の順で CSS を並べるので、名前が変わると後に来る方が変わることがある）
// 置き換えの対応（値は src/input.css の :root。見た目は変えない）
//   色の系統: gray→neutral、blue→primary、red→danger、amber→warning、emerald→success、purple→accent、orange→notice、
//             slate→hq（本部画面の地）、cyan→hq-accent（本部画面の差し色）、green→success-2、yellow→warning-2、indigo→accent-3
//             （violet は src/input.css だけで使っていて accent-2）
//   bg-white → bg-surface、text-[11px]/[10px]/[9px] → text-2xs/3xs/4xs、shadow-lg shadow-blue-200 → shadow-brand
//   style="…" と .style.cssText の #xxxxxx・rgba(255,255,255,…) → rgb(var(--color-…))
//   （印刷用の別ウィンドウ・メール・グラフの canvas は CSS 変数が効かないので対象外。onclick などイベント属性の中も変えない）
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const FAMILY = { gray: 'neutral', blue: 'primary', red: 'danger', amber: 'warning', emerald: 'success', purple: 'accent', orange: 'notice', slate: 'hq', cyan: 'hq-accent', green: 'success-2', yellow: 'warning-2', indigo: 'accent-3' }
// Tailwind の色を使うユーティリティ（border-x などの向きも含む）
export const COLOR_UTILS = 'bg|text|border|border-[xytrblse]|ring|ring-offset|divide|placeholder|outline|accent|fill|stroke|shadow|from|via|to|decoration|caret'
const RAW_FAMILIES = 'slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
// 置き換え前の直書き（Tailwind の色の名前）。neutral は置き換え後の名前と同じなので含めない
export const RAW_COLOR_RE = new RegExp(`(?<![\\w-])((?:[a-z0-9-]+:)*)(${COLOR_UTILS})-(${RAW_FAMILIES})-(\\d{2,3})(\\/\\d+)?(?![\\w-])`, 'g')
const SIZE = { '11px': '2xs', '10px': '3xs', '9px': '4xs' }

// 対象のファイル: 画面の JS と、HTML を出す TS（メールのテンプレート src/email-templates は CSS 変数が効かないので除く）
export function targetFiles() {
  const pub = readdirSync(join(ROOT, 'public/static')).filter(f => f.endsWith('.js')).map(f => 'public/static/' + f)
  const src = readdirSync(join(ROOT, 'src')).filter(f => /\.(ts|tsx)$/.test(f)).map(f => 'src/' + f)
  return [...pub, ...src]
}

// Tailwind の色の値（#rrggbb → 系統-段）。style の直書きを変数に置き換えるのに使う
let HEX = null
async function hexTable() {
  if (HEX) return HEX
  const colors = (await import('tailwindcss/colors.js')).default
  HEX = new Map()
  for (const [raw, fam] of Object.entries(FAMILY)) for (const [n, v] of Object.entries(colors[raw])) if (!HEX.has(v.toLowerCase())) HEX.set(v.toLowerCase(), `${fam}-${n}`)
  return HEX
}
const hex6 = h => h.length === 4 ? '#' + [...h.slice(1)].map(c => c + c).join('') : h
async function styleValue(s) {
  const t = await hexTable()
  return s
    // 白: 文字の色（color:）は色の付いた地・暗い地の上の文字、それ以外（背景・枠）は面の色
    .replace(/(^|[^-\w])color:\s*#(?:fff|ffffff)(?![0-9a-fA-F])/gi, '$1color:rgb(var(--color-on-primary))')
    .replace(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g, h => {
      const k = hex6(h.toLowerCase())
      if (k === '#ffffff') return 'rgb(var(--color-surface))'
      return t.has(k) ? `rgb(var(--color-${t.get(k)}))` : h
    })
  // 透明度つきの rgba(R,G,B,a) は変えない。rgb(var(--…) / a) にすると、Chrome は透明度を丸めずに重ねるため、
  // 重ねた色が 1 段（255 段階の 1）ずれることがある（rgba(15,23,42,.5) は 148、rgb(15 23 42 / .5) は 149）。
  // 見た目を変えないため、透明度つきの色は src/input.css では値ごとの変数（--color-backdrop・--shadow-focus など）にし、JS の中は今の値のままにする
}

// style を置き換えない行（別ウィンドウの印刷・メールなど、style.css を読まない HTML）。
// LIB_FALLBACK（CDN の部品を読めなかったときの案内）は style.css も読めない場合に備えて直書きのまま
const STYLE_SKIP = [/<style>/, /window\.open/, /font-family:\s*-apple-system/, /LIB_FALLBACK/]
// 画面の JS の中に書いた CSS（tour.js の案内の吹き出し）。行ごと style と同じ置き換えをする
const CSS_LINES = [{ file: 'public/static/tour.js', re: /^(#tour-(root|menu)|@keyframes tour-)/ }]
// 置き換えない行。イベント属性（ondragover など）の中のクラスは変えない約束なので、それと対になる行も今の名前のままにする
export const KEEP_LINES = [
  { file: 'public/static/admin.js', re: /getElementById\('doc-dropzone'\)\.classList/ },
]
// onclick などイベント属性の文字列（中は変えない）
const EVENT_ATTR_RE = /\bon[a-z]+="[^"]*"/g
const HOLD = '\u0001'

function transformLine(line) {
  // イベント属性はいったん取り出して、置き換えの後に戻す
  const held = []
  let s = line.replace(EVENT_ATTR_RE, m => { held.push(m); return `${HOLD}${held.length - 1}${HOLD}` })
  // 1. 色の系統
  s = s.replace(RAW_COLOR_RE, (m, pre, util, fam, n, alpha) => FAMILY[fam] ? `${pre}${util}-${FAMILY[fam]}-${n}${alpha || ''}` : m)
  // 2. 白の地
  s = s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)bg-white(\/\d+)?(?![\w-])/g, (m, pre, alpha) => `${pre}bg-surface${alpha || ''}`)
  // 3. 文字の大きさの直書き（11px・10px・9px）
  s = s.replace(/(?<![\w-])((?:[a-z0-9-]+:)*)text-\[(11px|10px|9px)\](?![\w-])/g, (m, pre, px) => `${pre}text-${SIZE[px]}`)
  // 4. 主色の影（ログインの画面のロゴ）
  s = s.replace(/(?<![\w-])shadow-lg shadow-primary-200(?![\w-])/g, 'shadow-brand')
  return { s, held }
}

export async function transform(text, file) {
  const styleOk = /^public\/static\/|^src\/index\.tsx$/.test(file)
  const keep = KEEP_LINES.filter(k => k.file === file)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (keep.some(k => k.re.test(lines[i]))) continue
    let { s, held } = transformLine(lines[i])
    // 5. style の直書きの色（画面の JS と index.tsx だけ。印刷・メールの行は飛ばす）
    if (styleOk && !STYLE_SKIP.some(re => re.test(s))) {
      const parts = []
      const re = /(style="[^"]*"|style='[^']*'|cssText\s*=\s*'[^']*')/g
      let last = 0, m
      while ((m = re.exec(s))) { parts.push(s.slice(last, m.index)); parts.push(await styleValue(m[0])); last = m.index + m[0].length }
      if (parts.length) { parts.push(s.slice(last)); s = parts.join('') }
    }
    if (CSS_LINES.some(c => c.file === file && c.re.test(s))) s = await styleValue(s)
    lines[i] = s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (m, k) => held[Number(k)])
  }
  return lines.join('\n')
}

// ---- --order: 効く方が入れ替わる組み合わせを探す ----
const SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '2xs', '3xs', '4xs'])
// クラスが決める CSS の性質（同じ性質のクラスが同じ要素に 2 つあると、CSS で後に来る方が効く）。色・文字の大きさ以外は null
function propOf(cls) {
  const m = cls.match(/^((?:[a-z0-9-]+(?:-\[[^\]]+\])?:)*)(.*)$/)
  const pre = m[1], body = m[2]
  let k = null, mm
  if ((mm = body.match(/^text-(.*)$/))) {
    const v = mm[1]
    if (SIZES.has(v) || /^\[\d+px\]$/.test(v)) k = 'font-size'
    else if (!/^(left|right|center|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/.test(v)) k = 'color'
  } else if ((mm = body.match(/^bg-(.*)$/))) {
    if (!/^(fixed|local|scroll|clip-|origin-|repeat|no-repeat|cover|contain|auto|center|top|bottom|left|right|gradient|none|opacity)/.test(mm[1])) k = 'background-color'
  } else if ((mm = body.match(/^(border(?:-[xytrblse])?)-(.*)$/))) {
    if (!/^([xytrblse]$|\d+|solid|dashed|dotted|double|none|hidden|collapse|separate|spacing|opacity|\[\d+px\])/.test(mm[2]) && mm[2] !== '') k = mm[1] + '-color'
  } else if ((mm = body.match(/^(ring|divide|placeholder|outline|accent|shadow|from|via|to|decoration)-(.*)$/))) {
    if (/^[a-z]+(-[a-z0-9]+)*-\d{2,3}(\/\d+)?$/.test(mm[2]) || /^(white|black|transparent|current|surface)$/.test(mm[2])) k = mm[1] + '-color'
  }
  return k ? pre + '|' + k : null
}
// class="…" の中を、いつも付く所と ${…} の中（条件で付く所）に分ける
function classAttrs(text) {
  const out = []
  const re = /class=\\?"/g
  let m
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length, depth = 0, stat = '', dyn = ''
    for (; i < text.length; i++) {
      const ch = text[i]
      if (depth === 0 && ch === '"') break
      if (ch === '$' && text[i + 1] === '{') { depth++; i++; dyn += ' '; continue }
      if (depth > 0 && ch === '{') depth++
      if (depth > 0 && ch === '}') { depth--; if (depth === 0) { stat += ' '; continue } }
      if (depth > 0) dyn += ch; else stat += ch
    }
    out.push({ pos: m.index, stat, dyn })
  }
  return out
}
const classTokens = s => [...new Set(s.match(/(?<![\w[-])(?:[a-z0-9-]+(?:-\[[^\]]+\])?:)*[a-z]+-[a-z0-9[\]/.-]+(?![\w-])/g) || [])]
export function orderFlips(text, file) {
  const flips = []
  for (const a of classAttrs(text)) {
    const all = [...classTokens(a.stat).map(t => [t, 's']), ...classTokens(a.dyn).map(t => [t, 'd'])]
    const by = new Map()
    for (const [t, w] of all) { const k = propOf(t); if (!k) continue; if (!by.has(k)) by.set(k, []); by.get(k).push([t, w]) }
    for (const arr of by.values()) {
      for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
        const [a1, w1] = arr[x], [a2, w2] = arr[y]
        // 条件で付くもの同士は、たいてい三項演算子のどちらか一方なので数えない
        if ((w1 === 'd' && w2 === 'd') || a1 === a2) continue
        const m1 = transformLine(a1).s, m2 = transformLine(a2).s
        if ((a1 > a2) !== (m1 > m2)) flips.push(`${file}:${text.slice(0, a.pos).split('\n').length} ${a1} / ${a2}（前は ${a1 > a2 ? a1 : a2}、後は ${m1 > m2 ? m1 : m2} が効く）`)
      }
    }
  }
  return flips
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check'), order = process.argv.includes('--order')
  let changed = 0
  const flips = []
  for (const f of targetFiles()) {
    const p = join(ROOT, f)
    const before = readFileSync(p, 'utf8')
    if (order) { flips.push(...orderFlips(before, f)); continue }
    const after = await transform(before, f)
    if (after === before) continue
    changed++
    if (check) { console.log('残っている:', f); continue }
    writeFileSync(p, after)
    console.log('置き換え:', f)
  }
  if (order) { for (const x of flips) console.log(x); console.log(`効く方が入れ替わる組み合わせ: ${flips.length} 件`); process.exit(flips.length ? 1 : 0) }
  if (check && changed) process.exit(1)
  console.log(changed ? `${changed} ファイル` : '置き換えるものはありません')
}
