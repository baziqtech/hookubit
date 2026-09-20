/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      // Every colour resolves through a CSS variable so light/dark is one
      // token swap rather than a `dark:` variant on every element.
      colors: {
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        'line-strong': 'rgb(var(--c-line-strong) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--c-ink-muted) / <alpha-value>)',
        'ink-subtle': 'rgb(var(--c-ink-subtle) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--c-accent-ink) / <alpha-value>)',
        'accent-soft': 'rgb(var(--c-accent-soft) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        'ok-soft': 'rgb(var(--c-ok-soft) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        'warn-soft': 'rgb(var(--c-warn-soft) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        'danger-soft': 'rgb(var(--c-danger-soft) / <alpha-value>)',
        info: 'rgb(var(--c-info) / <alpha-value>)',
        'info-soft': 'rgb(var(--c-info-soft) / <alpha-value>)',
        // From the pen.dev system: a nav surface distinct from `panel` (in
        // dark it is darker than the panels it sits beside), the saturated
        // badge-dot forms, a tinted accent border, chart gridlines, and a code
        // surface that stays dark in both themes.
        nav: 'rgb(var(--c-nav) / <alpha-value>)',
        'accent-line': 'rgb(var(--c-accent-line) / <alpha-value>)',
        'ok-dot': 'rgb(var(--c-ok-dot) / <alpha-value>)',
        'warn-dot': 'rgb(var(--c-warn-dot) / <alpha-value>)',
        'danger-dot': 'rgb(var(--c-danger-dot) / <alpha-value>)',
        grid: 'rgb(var(--c-grid) / <alpha-value>)',
        code: 'rgb(var(--c-code) / <alpha-value>)',
        'code-ink': 'rgb(var(--c-code-ink) / <alpha-value>)',
      },
      fontFamily: {
        // Both are SELF-HOSTED (@fontsource-variable, imported in index.css).
        // Inter used to be named here and never loaded, so the product silently
        // rendered in whatever the OS supplied; the fallbacks below are now a
        // genuine fallback rather than what everyone actually saw.
        sans: ['Inter Variable', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Dense by default: the product baseline is 13px, not 16px.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.05rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        // Display sizes, which the scale previously lacked entirely - every
        // heading above 14px was an arbitrary value. Taken from the design's
        // own clusters: section titles at 19, metric figures at 23, and the
        // one hero number at 34.
        title: ['1.1875rem', { lineHeight: '1.5rem', letterSpacing: '-0.01em' }],
        display: ['1.4375rem', { lineHeight: '1.75rem', letterSpacing: '-0.02em' }],
        hero: ['2.125rem', { lineHeight: '2.375rem', letterSpacing: '-0.025em' }],
      },
      boxShadow: {
        panel: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 1px -1px rgb(0 0 0 / 0.06)',
        pop: '0 8px 24px -6px rgb(0 0 0 / 0.18), 0 2px 6px -2px rgb(0 0 0 / 0.10)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(4px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'pop-in': 'pop-in 120ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
