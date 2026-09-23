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
    },
    mermaid: { theme: 'default' },
  }),
)
