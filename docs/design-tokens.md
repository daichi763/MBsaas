# 見た目のトークン（色・角丸・影・文字）

Sprint 26（#9977）で、画面の色・角丸・影・文字の大きさを CSS の変数（トークン）にまとめた。見た目はトークン化の前と同じ（前後のスクリーンショットで確認）。
UI の仕上げ（候補 A〜G）は、**変数の値を変えるだけ**で当てられる。画面の JS・HTML のクラスは変えなくてよい。

## どこにあるか

| ファイル | 中身 |
|---|---|
| `src/input.css` の `:root` | すべての変数と、その値（今の値は Tailwind の同じ段の色・既定の大きさ） |
| `src/input.css` の共通クラス（`.card` `.btn` `.inp` `.badge` `.modal-box` `.toast-msg` `.report-btn` など） | 役割の変数（`--color-primary` など）だけを使う。`#xxxxxx` は書かない |
| `tailwind.config.js` の `theme.extend` | `bg-primary-600` `text-neutral-500` `rounded-lg` `shadow-lg` `text-xs` などのクラスが同じ変数を見る |
| `scripts/tokens-codemod.mjs` | 直書きのクラスを置き換える道具（下の「新しく書くとき」） |
| `scripts/test-w26-tokens.mjs` | 直書きが残っていないか・値が前と同じか・変数で見た目が変わるかの確認 |

## 変数の一覧

色は `R G B` の 3 つの数で持つ（`rgb(var(--color-primary))`、透明にするときは `rgb(var(--color-primary) / .5)`）。Tailwind のクラスの透明度（`bg-surface/90` など）も効く。

### 段のある色（クラスで使う）

`--color-<系統>-<段>`（段は 50・100〜900・950）。クラスは `bg-<系統>-<段>` `text-<系統>-<段>` `border-<系統>-<段>` など。

| 系統 | 役割 | 今の値（Tailwind） |
|---|---|---|
| `neutral` | 灰（地・文字・枠） | gray |
| `primary` | 主色（主ボタン・選択中・リンク） | blue |
| `danger` | 誤り・削除・未提出 | red |
| `warning` | 注意・確認待ち | amber |
| `success` | 済み・正常 | emerald |
| `accent` | 分類の差し色 | purple |
| `accent-2` | 分類の差し色（`.badge-purple`・代わりのシフトの札。CSS だけ） | violet |
| `accent-3` | 分類の差し色（1 か所） | indigo |
| `notice` | 位置なし・仮押さえ・CSV の取り込み | orange |
| `success-2` | 別の緑（シフト管理の足りている枠・通知の受け取り中） | green |
| `warning-2` | 別の黄（1 か所） | yellow |
| `hq` | 本部画面（暗い地）の地・枠・文字 | slate |
| `hq-accent` | 本部画面の差し色 | cyan |

`-2`・`-3` は、今の見た目を変えないために残した少しだけ使う色。UI の仕上げで `success`・`warning`・`accent` にそろえてよい（値を同じにするだけでそろう）。

### 役割の色（共通クラスで使う。段の色を指している）

| 変数 | 今の値 | 使う所 |
|---|---|---|
| `--color-bg` | neutral-50 | ページの地 |
| `--color-surface` | 白 | カード・入力欄・メニュー（クラスは `bg-surface`） |
| `--color-surface-muted` | neutral-100 | 押せる物に乗せたときの面・灰の札 |
| `--color-surface-hover` | neutral-50 | 表の行・枠付きのボタンに乗せたとき・表の見出し |
| `--color-ink` | 黒 | 文字の色を決めていない所（body） |
| `--color-text` / `--color-text-strong` / `--color-text-sub` | neutral-800 / 900 / 600 | 本文・モーダル・補足 |
| `--color-muted` / `--color-faint` | neutral-500 / 400 | 薄い文字・アイコン・入力欄の空のときの文字 |
| `--color-border` / `--color-border-subtle` / `--color-border-strong` | neutral-200 / 100 / 300 | 入力欄・表（色を決めていない枠もこれ）・カード・強めの枠 |
| `--color-primary` / `-hover` / `-strong` / `-soft` / `-line` | primary-600 / 700 / 700 / 50 / 300 | 主ボタン・その上・主色の文字・選択中の面・フォーカスの線 |
| `--color-focus` | primary-500 | 入力欄のフォーカスの枠 |
| `--color-on-primary` | 白 | 色の付いた地・本部画面の暗い地の上の文字 |
| `--color-danger` / `-soft` / `-strong` | danger-600 / 100 / 700 | |
| `--color-success` / `-soft` | success-500 / 50 | |
| `--color-warning` / `-soft` | warning-700 / 100 | |
| `--color-overlay` | 15 23 42 | モーダル・案内の後ろを暗くする色 |
| `--color-toast` | neutral-900 | トーストの地 |

役割の色は段の色を指しているので、段の値を変えれば共通クラスとクラスの両方が変わる。共通クラスだけを変えたいときは役割の変数を上書きする。

### 角丸・影・文字

| 変数 | 今の値 | クラス・使う所 |
|---|---|---|
| `--radius-sm` `--radius` `--radius-md` `--radius-lg` `--radius-xl` `--radius-2xl` `--radius-3xl` | Tailwind の既定 | `rounded-sm`〜`rounded-3xl`（`rounded-full` はそのまま） |
| `--radius-card` / `--radius-ctrl` / `--radius-nav` / `--radius-toast` / `--radius-pill` | 1rem / .65rem / .6rem / .8rem / 999px | `.card` `.modal-box` `.report-btn` / `.btn` `.inp` / 左のメニュー / トースト / `.badge` |
| `--shadow-sm` `--shadow` `--shadow-md` `--shadow-lg` | Tailwind の既定 | `shadow-sm`〜`shadow-lg` |
| `--shadow-brand` | shadow-lg の形で primary-200 の色 | ログインの画面のロゴ（`shadow-brand`。前の `shadow-lg shadow-blue-200`） |
| `--shadow-card` `--shadow-next` `--shadow-toast` `--shadow-float` `--shadow-float-strong` | | `.card`・次の報告・トースト・開いたメニュー・保存のバー |
| `--font-sans` | ヒラギノ角ゴ・Noto Sans JP・メイリオ | body |
| `--text-xs`〜`--text-4xl` と `--leading-xs`〜`--leading-4xl` | Tailwind の既定 | `text-xs`〜`text-4xl`（行の高さも） |
| `--text-2xs` `--text-3xs` `--text-4xs` | 11px / 10px / 9px | `text-2xs` `text-3xs` `text-4xs`（前の `text-[11px]` など。行の高さは決めない） |
| `--text-badge` `--text-table` `--text-input` `--text-btn` `--text-toast` | .7rem / .82rem / .9rem / .85rem / .85rem | 共通クラスの文字 |

## 候補 A〜G を当てるとき

`src/input.css` の `:root` の値だけを変える。たとえば候補 B（落ち着いた業務向け）の主色と角丸なら:

```css
:root {
  --color-primary-500: 31 95 175; --color-primary-600: 31 95 175; --color-primary-700: 25 78 144;  /* 主色・その上 */
  --color-primary-50: 238 244 251; --color-primary-100: 238 244 251;                               /* 選択中の面 */
  --color-neutral-50: 246 247 249;                                                                  /* ページの地 */
  --color-neutral-400: 95 102 114; --color-neutral-500: 95 102 114;                                 /* 薄い文字をそろえる */
  --radius-lg: 6px; --radius-xl: 8px; --radius-2xl: 8px; --radius-card: 8px; --radius-ctrl: 6px;
  --shadow-sm: none; --shadow: none; --shadow-card: none;
  --text-2xs: 12px; --text-3xs: 12px;                                                               /* 10〜11px を使わない */
}
```

候補の CSS（11/11 の撮影用。`html .text-blue-600 { … }` のようにクラスを上書きしていた）は、クラスごとの指定を「段の変数の値」に読み替えれば同じになる。
スタッフアプリだけ・本部画面だけ値を変えたいときは、`html[data-app="staff"]` のようにページの印を付けて、その下で変数を上書きする（今は印が無い。必要になったら index.tsx の body に付ける）。

## 新しく書くとき

- 色は段のクラス（`bg-primary-600` `text-neutral-500` など）か役割のクラス（`bg-surface` `bg-page` `text-ink` `text-muted` `border-line`）を使う。`bg-gray-50` `bg-white` `text-[11px]` や `style="color:#…"` は書かない。
- 書いてしまったときや、ほかの作業から直書きのクラスが入ったときは、`node scripts/tokens-codemod.mjs` を流すと置き換わる（何度流しても同じ結果）。
  先に `node scripts/tokens-codemod.mjs --order` を流すと、置き換えで名前の並びが変わり、同じ要素の同じ種類のクラスで効く方が入れ替わる所を出す（0 件であること）。
- `scripts/test-w26-tokens.mjs` が、直書きが残っていないことと、値が前と同じことを確かめる。

## 変数にしていない所（理由）

| 所 | 理由 |
|---|---|
| メール（`src/email-templates`・`src/hq-support.ts` のメールの HTML） | メールのソフトは CSS の変数を読まない |
| 印刷用の別ウィンドウ（`roster.js` の ID カード・`src/settlement.ts`・`src/shift-board.ts` の印刷の HTML） | style.css を読まない別の文書 |
| `index.tsx` の `LIB_FALLBACK`（CDN の部品を読めなかったときの案内） | 通信の悪いときに style.css も読めない場合に備える |
| `index.tsx` の `<meta name="theme-color">`・`manifest.webmanifest` | ブラウザ・OS が読む値で、CSS の変数は使えない |
| 実績分析のグラフの分類の色（`admin.js` の `ACHART_COLORS`） | グラフの見分け用の色。主色のグラフは `tokenColor('primary')`（common.js）で変数から読む |
| `admin.js` の資料の置き場の `ondragover`・`ondragleave` とその対の行（`border-blue-400` `bg-blue-50`） | イベント属性の中は変えない約束。onclick などを整理するときに一緒に置き換える |
| シフト管理の部品の小さな角丸（.3rem〜.9rem）・左のメニューの見出しの角 | その部品だけの形。候補で変えるときは個別に直す |
