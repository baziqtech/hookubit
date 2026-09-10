/**
 * The two things the auth pages need that Tailwind cannot express from
 * `tailwind.config.js`: the autofill repair, and one entrance animation.
 *
 * It is injected as a single `<style>` element by `AuthLayout` rather than
 * added to `src/index.css`, because neither is used anywhere else and the app
 * shell should not pay for them. Everything resolves through the same `--c-*`
 * tokens as the rest of the theme, so light and dark are one swap.
 *
 * What used to be here — a dot-grid background, a breathing accent glow, and
 * five keyframes driving an animated delivery diagram — went with the diagram.
 * See the note in `AuthLayout`.
 */
export const AUTH_STYLES = `
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

@keyframes hb-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.hb-rise { animation: hb-rise 520ms cubic-bezier(0.16, 1, 0.3, 1) both; }

@media (prefers-reduced-motion: reduce) {
  .hb-rise { animation: none !important; opacity: 1 !important; transform: none !important; }
}
`;
