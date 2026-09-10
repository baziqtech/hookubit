/**
 * The handful of things the sign-in screen needs that Tailwind cannot express
 * from `tailwind.config.js` — keyframes the config does not declare, the
 * autofill repair, and the decorative grid/glow.
 *
 * It is injected as one `<style>` element by `AuthLayout` rather than added to
 * `src/index.css`, because none of it is used anywhere else in the product and
 * the app shell should not pay for it. Everything resolves through the same
 * `--c-*` tokens as the rest of the theme, so light and dark are one swap and
 * there is no second palette hiding in here.
 *
 * Every animation is opt-in by class name and every one of them is switched
 * off under `prefers-reduced-motion` — listed explicitly rather than with a
 * blanket `*`, so a genuinely informative animation (the submit button's
 * spinner) keeps running when a decorative one stops.
 */
export const AUTH_STYLES = `
.hb-auth-grid {
  background-image: radial-gradient(circle at 1px 1px, rgb(var(--c-line-strong) / 0.6) 1px, transparent 0);
  background-size: 22px 22px;
  mask-image: radial-gradient(70% 60% at 50% 42%, #000 30%, transparent 100%);
  -webkit-mask-image: radial-gradient(70% 60% at 50% 42%, #000 30%, transparent 100%);
}

.hb-auth-glow {
  background: radial-gradient(58% 50% at 50% 34%, rgb(var(--c-accent) / 0.20), transparent 72%);
  animation: hb-breathe 9s ease-in-out infinite;
}

/* Autofill: Chrome paints its own background and text colour over the field,
   which reads as a broken input on a dark theme. Clipping the background to
   the text and restating the fill colour keeps the token palette, and unlike
   the usual inset box-shadow trick it does not fight the focus ring. */
.hb-auth input:-webkit-autofill,
.hb-auth input:-webkit-autofill:hover,
.hb-auth input:-webkit-autofill:focus {
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: rgb(var(--c-ink));
  caret-color: rgb(var(--c-ink));
}

@keyframes hb-flow { to { stroke-dashoffset: -20; } }
.hb-flow { stroke-dasharray: 2 8; stroke-linecap: round; animation: hb-flow 1.9s linear infinite; }

@keyframes hb-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.hb-rise { animation: hb-rise 620ms cubic-bezier(0.16, 1, 0.3, 1) both; }

@keyframes hb-ping {
  0% { r: 4; opacity: 0.5; }
  70% { r: 13; opacity: 0; }
  100% { r: 13; opacity: 0; }
}
.hb-ping { animation: hb-ping 2.6s cubic-bezier(0.16, 1, 0.3, 1) infinite; }

@keyframes hb-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.hb-breathe { animation: hb-breathe 3.4s ease-in-out infinite; }

@keyframes hb-spin { to { transform: rotate(360deg); } }
.hb-spin { transform-box: fill-box; transform-origin: center; animation: hb-spin 1.6s linear infinite; }

@keyframes hb-countdown { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 56; } }
.hb-countdown { stroke-dasharray: 56; animation: hb-countdown 4s linear infinite; }

@media (prefers-reduced-motion: reduce) {
  .hb-flow, .hb-rise, .hb-ping, .hb-breathe, .hb-spin, .hb-countdown, .hb-auth-glow {
    animation: none !important;
  }
  .hb-rise { opacity: 1 !important; transform: none !important; }
  .hb-flow { stroke-dasharray: none; }
}
`;
