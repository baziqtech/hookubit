import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { buildNav, buildSidebar } from './sidebar.mts'

/**
 * Customer-facing documentation for HookuBit.
 *
 * The site renders the markdown in this directory and nothing else - there is
 * no second copy to keep in sync, and the markdown is readable in an editor
 * with no build at all. The API reference under api/ is GENERATED from the
 * control plane's OpenAPI document by scripts/generate-api-reference.mjs, so
 * it cannot drift from the code; edit the generator or the source, never the
 * output.
 *
 * No sign-in gate: this documentation is public by design. Nothing in it is
 * secret, and a customer evaluating the product must be able to read it before
 * they have an account.
 */
export default withMermaid(
  defineConfig({
    title: 'HookuBit',
    description: 'Reliable webhook delivery: durable ingestion, materialised routing, retries, signing, and a delivery log you can answer questions from.',
    srcDir: '.',
    // Repo-facing file for people browsing the folder rather than the site.
    // No `**/` - each section's own README.md must stay included, because
    // `rewrites` below turns it into that section's index page.
    srcExclude: ['README.md'],
    cleanUrls: true,
    lastUpdated: true,
    rewrites: {
      ':section/README.md': ':section/index.md',
    },
    // Dead-link checking stays ON. A build failure here is a real broken link:
    // fix the link, not this setting.
    themeConfig: {
      siteTitle: 'HookuBit docs',
      nav: buildNav(),
      sidebar: buildSidebar(),
      search: { provider: 'local' },
      outline: { level: [2, 3], label: 'On this page' },
      docFooter: { prev: 'Previous', next: 'Next' },
      lastUpdated: { text: 'Last updated' },
      footer: {
        message: 'Every claim on this site names the source it came from. If the docs and the product disagree, the product wins - then tell us.',
      },
    },
    vite: {
      server: { port: 4000, host: true },
      // Pre-bundle mermaid, or `vitepress dev` serves a blank page.
      //
      // mermaid depends on packages that still ship only CommonJS - dayjs is
      // the first one to bite: its `main` is a UMD bundle and it declares no
      // `module` and no `exports`, so the browser's native ESM loader sees no
      // default export and the whole app fails to boot before it mounts.
      // Listing mermaid here makes Vite run it through esbuild, which bundles
      // those deps and synthesises the interop. `vitepress build` was never
      // affected - Rollup does the same interop on its own - which is why this
      // could break while the build stayed green.
      //
      // vitepress-plugin-mermaid tries to do this itself, but it names the
      // sub-dependencies as bare specifiers (`dayjs`, `cytoscape`, ...). Under
      // pnpm's non-hoisted layout they are not resolvable from apps/docs, so
      // Vite drops them with "Failed to resolve dependency" - expect those five
      // warnings on a COLD dev start; once .vitepress/cache exists they are
      // gone, and they are upstream's and harmless either way. Naming
      // `mermaid` works because mermaid IS a direct devDependency here, and it
      // keeps working when mermaid changes which CJS packages it pulls in.
      optimizeDeps: {
        include: ['mermaid'],
      },
    },
    mermaid: { theme: 'default' },
  }),
)
