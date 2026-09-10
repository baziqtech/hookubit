# HookuBit documentation

Customer-facing documentation for HookuBit, plus a VitePress site to read it in a browser.

```
apps/docs/
  index.md            landing page
  guide/              integrating with HookuBit: publish, receive, verify, retry, rotate, replay
  api/                the API reference - GENERATED from apps/control-api/openapi.json, do not edit
  self-hosting/       running HookuBit against your own PostgreSQL
  scripts/            the API reference generator
  .vitepress/         site config and the sidebar generator (walks the folders; no config edit to add a page)
  wrangler.jsonc      Cloudflare static-assets deploy, no gate
```

Read the markdown in an editor, or run `./run-docs` for the site with a sidebar,
full-text search, rendered diagrams and dark mode on <http://localhost:4000>.
`pnpm -r build` builds it in CI with dead-link checking on, so a broken
cross-reference fails the build.

There is no sign-in. The site is public by design.
