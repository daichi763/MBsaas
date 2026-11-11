/** @type {import('tailwindcss').Config} */
// 見た目のトークン（UI-3）: 色・角丸・影の値は src/input.css の :root の CSS 変数だけに書く（ここは名前を付けるだけ）。
// 色は役割の名前（ink・muted・line・primary・success・warning・danger など）で使う。例: text-primary・bg-primary-soft・border-line
// 主色を替えるときは :root の --c-primary* だけを直す。gray の段も :root の --c-gray-* に寄せている（中間色を1系統にするため）
const v = (name) => `rgb(var(${name}) / <alpha-value>)`
module.exports = {
  content: [
    "./src/**/*.{ts,tsx,js,jsx}",
    "./public/**/*.{js,html}",
  ],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: v('--c-primary'), hover: v('--c-primary-hover'), strong: v('--c-primary-strong'), soft: v('--c-primary-soft'), line: v('--c-primary-line'), dark: v('--c-primary-dark') },
        'on-primary': v('--c-on-primary'),
        ink: { DEFAULT: v('--c-ink'), sub: v('--c-ink-sub') },
        muted: v('--c-muted'),
        icon: v('--c-icon'),
        line: { DEFAULT: v('--c-line'), subtle: v('--c-line-subtle'), strong: v('--c-line-strong') },
        canvas: v('--c-canvas'),
        fill: v('--c-fill'),
        surface: v('--c-surface'),
        success: { DEFAULT: v('--c-success'), soft: v('--c-success-soft'), line: v('--c-success-line') },
        warning: { DEFAULT: v('--c-warning'), soft: v('--c-warning-soft'), line: v('--c-warning-line') },
        danger: { DEFAULT: v('--c-danger'), soft: v('--c-danger-soft'), line: v('--c-danger-line') },
        // 中間色の段（Tailwind の gray を青みの灰1系統に置き換える。既存の text-gray-500 なども同じ系統になる）
        gray: {
          50: v('--c-gray-50'), 100: v('--c-gray-100'), 200: v('--c-gray-200'), 300: v('--c-gray-300'), 400: v('--c-gray-400'),
          500: v('--c-gray-500'), 600: v('--c-gray-600'), 700: v('--c-gray-700'), 800: v('--c-gray-800'), 900: v('--c-gray-900'),
        },
      },
      borderRadius: {
        tag: 'var(--r-tag)',
        ctrl: 'var(--r-ctrl)',
        card: 'var(--r-card)',
      },
      // 影はカードに使わない（shadow-sm・shadow は付けても出ない）。浮くもの（メニュー・トースト）は float、モーダルは modal
      boxShadow: {
        sm: 'none',
        DEFAULT: 'none',
        md: 'var(--sh-float)',
        lg: 'var(--sh-float)',
        xl: 'var(--sh-modal)',
        '2xl': 'var(--sh-modal)',
        float: 'var(--sh-float)',
        modal: 'var(--sh-modal)',
      },
    },
  },
  plugins: [],
}
