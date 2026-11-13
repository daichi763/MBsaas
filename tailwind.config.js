/** @type {import('tailwindcss').Config} */
// 見た目のトークン（Sprint 26 #9977）: 色・角丸・影・文字の大きさのクラスは src/input.css の :root の CSS 変数を見る。
// 見た目を変えるときは、ここではなく変数の値を変える（使い方は docs/design-tokens.md）。
// 色は「R G B」の 3 つの数で持ち、bg-surface/90 のような透明度の指定も効くようにする
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const rgb = (name) => `rgb(var(--color-${name}) / <alpha-value>)`
const family = (name, extra = {}) => ({ ...extra, ...Object.fromEntries(SHADES.map(n => [n, rgb(`${name}-${n}`)])) })

module.exports = {
  content: [
    "./src/**/*.{ts,tsx,js,jsx}",
    "./public/**/*.{js,html}",
  ],
  theme: {
    extend: {
      colors: {
        // 段のある色（今の値は Tailwind の同じ段の色。対応は scripts/tokens-codemod.mjs の FAMILY）
        neutral: family('neutral'),
        primary: family('primary', { DEFAULT: rgb('primary') }),
        danger: family('danger', { DEFAULT: rgb('danger') }),
        warning: family('warning', { DEFAULT: rgb('warning') }),
        success: family('success', { DEFAULT: rgb('success') }),
        accent: family('accent'),
        'accent-2': family('accent-2'),
        'accent-3': family('accent-3'),
        notice: family('notice'),
        'success-2': family('success-2'),
        'warning-2': family('warning-2'),
        hq: family('hq'),
        'hq-accent': family('hq-accent'),
        // 役割の名前（新しく書く所はこちらを使う）
        surface: rgb('surface'),
        page: rgb('bg'),
        ink: rgb('text'),
        muted: rgb('muted'),
        line: rgb('border'),
      },
      // 角丸（rounded・rounded-lg など。rounded-full はそのまま）
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
      },
      // 影（shadow-sm・shadow・shadow-md・shadow-lg と、ログインの画面のロゴの主色の影）
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        brand: 'var(--shadow-brand)',
      },
      // 文字の大きさ（行の高さも変数）。2xs〜4xs は 11px・10px・9px の直書きを置き換えたもので、行の高さは決めない（今までどおり）
      fontSize: {
        '4xs': 'var(--text-4xs)',
        '3xs': 'var(--text-3xs)',
        '2xs': 'var(--text-2xs)',
        xs: ['var(--text-xs)', { lineHeight: 'var(--leading-xs)' }],
        sm: ['var(--text-sm)', { lineHeight: 'var(--leading-sm)' }],
        base: ['var(--text-base)', { lineHeight: 'var(--leading-base)' }],
        lg: ['var(--text-lg)', { lineHeight: 'var(--leading-lg)' }],
        xl: ['var(--text-xl)', { lineHeight: 'var(--leading-xl)' }],
        '2xl': ['var(--text-2xl)', { lineHeight: 'var(--leading-2xl)' }],
        '3xl': ['var(--text-3xl)', { lineHeight: 'var(--leading-3xl)' }],
        '4xl': ['var(--text-4xl)', { lineHeight: 'var(--leading-4xl)' }],
      },
    },
  },
  plugins: [],
}
