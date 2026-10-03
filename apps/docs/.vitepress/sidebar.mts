import fs from 'node:fs'
import path from 'node:path'

/**
 * Nav and sidebar are built by walking the filesystem, so adding a page or a
 * section is a matter of dropping a markdown file in - no config edit.
 *
 * A "section" is any top-level directory containing markdown. Within one,
 * ordering is deliberate rather than alphabetical: README first, then the
 * numbered chapters, then anything unnumbered, with `glossary` pinned last and
 * sub-directories as nested groups. Sections themselves follow SECTION_ORDER,
 * because "Guide, then API, then self-hosting" is a reading order and
 * alphabetical is not.
 */

const ROOT = path.resolve(import.meta.dirname, '..')
const IGNORED = new Set(['node_modules', '.vitepress', 'public', 'assets', 'scripts'])

const SECTION_ORDER = ['guide', 'dashboard', 'api', 'self-hosting']
const DISPLAY_NAMES: Record<string, string> = {
  guide: 'Guide',
  dashboard: 'Dashboard',
  api: 'API reference',
  'self-hosting': 'Self-hosting',
}

interface Item {
  text: string
  link: string
}

/** Prefer the document's own H1 - filenames are slugs, headings are written for people. */
function titleOf(file: string): string {
  const firstHeading = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .find((line) => line.startsWith('# '))
  if (firstHeading) return firstHeading.replace(/^#\s+/, '').trim()
  return path
    .basename(file, '.md')
    .replace(/^\d+[-.]?\s*/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** README -> first, `04-retries` -> 4, glossary -> last, everything else in between. */
function rank(name: string): number {
  if (/^readme\.md$/i.test(name)) return -1
  if (/^glossary\.md$/i.test(name)) return 9999
  const numbered = name.match(/^(\d+)/)
  return numbered ? Number(numbered[1]) : 5000
}

function markdownIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function itemsFor(dir: string, urlBase: string): Item[] {
  return markdownIn(dir).map((file) => {
    const isReadme = /^readme\.md$/i.test(file)
    return {
      text: isReadme ? 'Overview' : titleOf(path.join(dir, file)),
      link: isReadme ? `${urlBase}/` : `${urlBase}/${file.replace(/\.md$/, '')}`,
    }
  })
}

function label(name: string): string {
  return DISPLAY_NAMES[name] ?? name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function sections(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED.has(e.name))
    .map((e) => e.name)
    .filter((name) => markdownIn(path.join(ROOT, name)).length > 0)
    .sort((a, b) => {
      const ia = SECTION_ORDER.indexOf(a)
      const ib = SECTION_ORDER.indexOf(b)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b)
    })
}

export function buildSidebar() {
  const sidebar: Record<string, any[]> = {}
  for (const section of sections()) {
    const dir = path.join(ROOT, section)
    const base = `/${section}`
    const group: any = { text: label(section), collapsed: false, items: itemsFor(dir, base) }
    const subDirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
    for (const sub of subDirs) {
      const subItems = itemsFor(path.join(dir, sub), `${base}/${sub}`)
      if (!subItems.length) continue
      group.items.push({ text: label(sub), collapsed: false, items: subItems })
    }
    // Sidebar is per-section: reading the guide should not show every API page.
    sidebar[`${base}/`] = [group]
  }
  return sidebar
}

export function buildNav() {
  return sections().map((section) => ({ text: label(section), link: `/${section}/` }))
}
