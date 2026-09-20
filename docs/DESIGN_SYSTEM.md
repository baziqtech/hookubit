# HookuBit — design system

**What this is.** A description of the interface as it exists in code today,
written to be handed to a branding exercise. Everything in *The system as built*
was read out of `apps/dashboard/` and is true as of this commit; everything in
*Open questions* is a decision nobody has made yet, stated plainly so a designer
can make it rather than infer it.

**Status.** A design was delivered as `hookubit.pen` (pen.dev) covering 28
screens and a component library, and its system — tokens, both themes, two
typefaces, a display scale — has been adopted. Four of the seven open questions
below are now answered and marked as such. What the design proposed that this
product does not do was deliberately not built; §16 lists it.

Source of truth for the values below:
`apps/dashboard/tailwind.config.js`, `apps/dashboard/src/index.css`,
`apps/dashboard/src/components/`. If this file and those disagree, they are
right and this is stale.

---

## 1. The product, in one paragraph

HookuBit delivers webhooks. A customer's system publishes an event once;
HookuBit stores it durably, fans it out to every subscribed endpoint, signs each
request, retries what fails with backoff, and keeps a permanent record of every
attempt. **The record is the product.** The reason someone pays for this is not
the retry loop — it is being able to answer "did finance ever receive that
settlement?" at 2am without opening psql.

That sentence should govern the brand. This is infrastructure for a person
under pressure, not a consumer app and not a growth-stage SaaS.

## 2. Who is looking at it, and when

| | |
|---|---|
| **Primary user** | A backend engineer or an ops lead at a company that sends webhooks to its customers. |
| **Second user** | Their customer's engineer, who never sees this UI — they see a signed HTTP request and the public docs. |
| **Typical session** | Scanning a delivery table for the one row that failed. Long, dense, repetitive. |
| **Worst-case session** | An incident. Somebody is angry, something is down, and the answer has to be on screen in under a minute. |
| **Frequency** | Daily for an operator; monthly for a manager; once, urgently, for everyone else. |

Design consequence: **density beats generosity everywhere inside the app.** The
operator is here to read tables, not to admire chrome. The auth pages are the
one place that is not true — see §12.

---

# The system as built

*Fixed unless the branding work explicitly changes it. Where something is
already known to be wrong, it says so.*

## 3. Colour

Every colour resolves through a CSS custom property, so light and dark are one
token swap rather than a `dark:` variant per element. **There is no second
palette anywhere in the product, and there must not be.**

### Surfaces, text and lines

| Token | Light | Dark | Use |
|---|---|---|---|
| `canvas` | `#F6F7F9` | `#0B0D11` | The page. |
| `panel` | `#FFFFFF` | `#12151B` | Cards, tables, form fields. |
| `raised` | `#F1F3F6` | `#1E232C` | Hover states, disabled fields, inset strips. |
| `nav` | `#FFFFFF` | `#0E1116` | The sidebar rail — its own surface, distinct from `panel`. |
| `line` | `#E3E6EB` | `#232932` | Every hairline border. |
| `line-strong` | `#CDD3DB` | `#333B47` | Hover borders, input borders, scrollbar thumb. |
| `grid` | `#EDEFF3` | `#1C212A` | Chart gridlines. |
| `ink` | `#0D1117` | `#E9EDF2` | Primary text. |
| `ink-muted` | `#5C6672` | `#8B95A3` | Secondary text, labels. |
| `ink-subtle` | `#8792A0` | `#68727F` | Tertiary — hints, timestamps, footnotes. |
| `code` / `code-ink` | `#0E1117` / `#D6DEE8` | `#080A0D` / `#D6DEE8` | Payloads and signatures. **Dark in both themes** — a payload is a quotation from another system and reads as one when it keeps its own surface. |

The palette is **cool** throughout, in both themes. It used to be warm stone in
light and cool neutral in dark, which nobody had decided; that is resolved.

### Accent

| Token | Light | Dark |
|---|---|---|
| `accent` | `#4C4DDC` | `#7E7CF5` |
| `accent-ink` | `#FFFFFF` | `#0B0D11` |
| `accent-soft` | `#EDEDFD` | `#1E1E3A` |
| `accent-line` | `#C9C9F7` | `#3A3A6B` |

The accent carries: primary buttons, links, focus rings, the active nav item,
text selection, and the product mark. It was Tailwind's factory indigo, chosen
by nobody; it is now the design's, chosen on purpose.

### Status — the domain's colour vocabulary

These are not decoration. A delivery has nine states and an operator reads them
by colour before they read the word.

| Tone | Light | Dark | Means |
|---|---|---|---|
| `ok` | `#0E7C5A` | `#34D399` | Succeeded. Terminal and good. |
| `warn` | `#9A5B06` | `#FBBF24` | Retrying. Failing, but not over. |
| `danger` | `#BC2B41` | `#FB7185` | Failed, or exhausted — terminal and bad. |
| `info` | `#1D66C4` | `#60A5FA` | Processing. In flight right now. |
| neutral | `ink-muted` on `raised` | — | Pending, scheduled, queued, cancelled. |

Each has a `-soft` companion for badge backgrounds, and `ok`/`warn`/`danger`
each have a **`-dot`** form (`#12A472`, `#E08A0B`, `#E0475E`) used only for the
6px badge dot: a colour chosen for contrast as 11.5px text reads as grey at dot
size, so the dot carries more chroma than the label beside it.

**Rule: colour is never the only carrier of meaning.** Every status badge pairs
its colour with the word, and every chart is accompanied by a table of the same
numbers. A branding change may re-pitch these five hues but may not reduce them
below five distinguishable values, and must keep them distinguishable to the
~8% of male engineers with a red/green deficiency — which the current
`ok`/`danger` pair does only marginally.

## 4. Typography

### The scale

Defined in `tailwind.config.js`. Dense on purpose: **the product baseline is
13px, not 16px.**

| Name | Size | Line height | Use |
|---|---|---|---|
| `2xs` | 11px | 16px | Timestamps, footnotes, table meta, badges. |
| `xs` | 12px | 16.8px | Labels, nav items, secondary rows. |
| `sm` | 13px | 20px | **Body default** (`<body>` is `text-sm`). |
| `base` | 14px | 22px | Emphasised body, dialog content. |
| `title` | 19px | 24px, −0.01em | Section and page headings. |
| `display` | 23px | 28px, −0.02em | Metric figures. |
| `hero` | 34px | 38px, −0.025em | The one headline on an auth page. |

The scale used to stop at 14px, so every heading above it was an arbitrary
value. The three display sizes are the design's own clusters.

### The typefaces

**Inter** for the interface, **JetBrains Mono** for payloads, signatures, IDs
and headers. Both are self-hosted through `@fontsource-variable/*` and imported
at the top of `src/index.css` — no CDN at runtime, no third-party request on a
page that is about to hold a session cookie.

```js
sans: ['Inter Variable', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
mono: ['JetBrains Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
```

This was a live defect until the design landed: `Inter` was named in the config
and **never loaded** — no `<link>`, no `@font-face`, no package — so a string
set in Inter measured exactly as wide as the same string in a nonexistent
family, and the product silently rendered in whatever the OS supplied. Every
screenshot taken before this was of the system font. The fallbacks above are
now a genuine fallback rather than what everybody actually saw.

Variable builds: one file per family, every weight from 100–900, so the 500 and
600 the design leans on cost nothing extra.

### Numerals

Anything columnar uses the `.tabular` utility (`font-variant-numeric:
tabular-nums`) so figures line up down a table. Any replacement face must have
tabular figures.

## 5. Space, radius, elevation

- **Space** — Tailwind's default 4px scale, unmodified. Dense in the shell
  (`gap-1`/`gap-2`, `px-2 py-1.5` on nav rows, `px-3 py-1.5` table cells),
  looser on auth (`gap-3.5`, `py-10`).
- **Radius** — `rounded` (4px) and `rounded-md` (6px) dominate, `rounded-lg`
  (8px) for fields and dialogs, `rounded-full` for pills and dots. Usage counts:
  `rounded-md` 43, `rounded` 43, `rounded-lg` 21, `rounded-full` 21, `rounded-xl`
  4, `rounded-2xl` 1. The two outliers are unconsidered rather than intentional.
- **Elevation** — two shadows only, and they are deliberately almost invisible:
  `shadow-panel` (`0 1px 2px rgb(0 0 0 / 0.04)`) for resting surfaces and
  `shadow-pop` for menus and dialogs. **The product separates surfaces with
  hairlines, not shadows.** Used 6 and 3 times respectively across the whole app.

## 6. Motion

Three animations exist, all short:

| | |
|---|---|
| `fade-in` | 120ms ease-out |
| `pop-in` | 120ms `cubic-bezier(0.16, 1, 0.3, 1)` — dialogs, menus |
| `shimmer` | 1.6s linear infinite — skeleton loading only |

**Motion is functional, never decorative.** 120ms is the house duration.
Anything that loops has to justify itself, and anything decorative must be
switched off under `prefers-reduced-motion` — listed explicitly, never with a
blanket `*`, so a genuinely informative animation (a submit spinner) keeps
running when a decorative one stops.

## 7. Focus and selection

One focus treatment for the entire product, so a keyboard user gets the same
affordance on every primitive:

```css
:where(a, button, input, select, textarea, [tabindex]):focus-visible {
  outline: none; ring: 2px accent/70; ring-offset: 2px canvas;
}
::selection { background: accent/25; }
```

The ring offsets against `canvas`. Any surface that is not `canvas` must
restate `ring-offset-*` or it leaves a visible seam.

## 8. Components

25 components in `src/components/`. The set is small on purpose: every addition
is something the whole product must then keep consistent.

| Component | Variants / notes |
|---|---|
| `Button` | `variant`: primary, secondary, ghost, danger · `size`: sm, md · `shape`: default, pill · `loading` (spinner + `aria-busy`) |
| `Badge` | tones ok / warn / danger / info / neutral, optional dot, optional pulse |
| `Table` | typed columns, required `caption`, `align`, `secondary` de-emphasis |
| `Panel` / `PageHeader` / `Stat` | the page furniture |
| `Dialog` | native `<dialog>`, focus trap, unmounts when closed |
| `Field` / `Input` / `Select` | label + hint + error wiring, `aria-describedby`, `aria-invalid` |
| `Async` | one loading/error/empty envelope for every query |
| `EmptyState` / `ErrorState` / `Placeholder` / `NoBackendRoute` | the four "nothing here" cases, which are **not** the same case |
| `Skeleton` | `aria-hidden`, paired with one live region |
| `WriteErrorNotice` / `PermissionDenied` / `GatedButton` | failure and permission surfaces |
| `SecretReveal` | one-time credential display |
| `Pager`, `Tabs`, `CodeBlock`, `StatusLegend`, `ThemeToggle`, `DemoDataBanner` | |

The auth pages deliberately fork *scale only* (`AuthField`, 44px controls
against the shell's 32px) while using the same tokens, focus treatment and
label wiring.

## 9. Patterns worth preserving

- **Four kinds of nothing.** "No rows yet" (`EmptyState`), "the request failed"
  (`ErrorState`), "this screen is unbuilt" (`Placeholder`), and "the API has no
  route for this" (`NoBackendRoute`) are different messages and look different.
  The product never fabricates data to fill a space.
- **Failure is specific.** Every error surface prints `request_id` when the
  server sent one; it is the only handle support has.
- **Permissions are shown, not hidden.** A control the role cannot use renders
  disabled *with the reason in its title*, rather than disappearing.
- **One-time secrets are never cached.** Plaintext lives in component state and
  nowhere else.
- **Numbers are never invented.** A success rate with nothing settled renders
  `—`, not `0%`.

## 10. Voice

The strongest asset the product currently has, and it is already consistent.
Real examples:

> "An endpoint is the URL we POST to. Nothing is delivered until one exists."

> "Created up front, before anything is sent, so it is the record of what
> SHOULD arrive. Each has its own retry chain."

> "Each endpoint has its own concurrency, rate limit and circuit breaker — a
> slow one cannot starve the others."

> "Nothing here has been fixed. The circuit breaker disabled this endpoint
> because the consumer stopped answering, and resuming does not change the
> consumer."

The rules that produce it:

1. **Say the mechanism.** Not "something went wrong" — say what the system did
   and why.
2. **Never claim more than is true.** Enumeration-safe responses say "if that
   address can receive mail", not "we sent an email".
3. **Name the consequence before the action.** "Queued deliveries are cancelled
   as workers reach them" comes before the Pause button.
4. **British spelling, plain words, no exclamation marks, no jokes in failure
   paths.** Sentence case for every heading and button.
5. **No marketing register anywhere inside the product.** No "seamless", no
   "powerful", no "effortless".

Branding may set a louder voice for marketing surfaces, but **the in-product
voice above is settled and should not be softened.**

## 11. Accessibility — non-negotiable

Currently upheld across the codebase (file counts in parentheses):
`aria-describedby` (20), `aria-label` (20), `sr-only` (18), `aria-invalid` (17),
`role="alert"` (14), table `caption` (14), `aria-busy` (6), `aria-live` (2).

Rules any visual change must keep: a real `<label for>` on every input; status
never carried by colour alone; visible focus on every interactive element; a
table `caption` even when visually hidden; charts backed by a real table;
`prefers-reduced-motion` honoured.

## 12. Two contexts, not one

This matters for briefing a designer, because they pull in opposite directions.

| | **Operator shell** | **Auth pages** |
|---|---|---|
| Goal | Scan and act, repeatedly | Get one person through, once |
| Density | Maximum — 13px baseline, 32px controls | Generous — 44px controls, 40px headline |
| Surface | `panel` sidebar on `canvas`, hairlines everywhere | Flat `canvas`, one centred 25rem column |
| Chrome | Sidebar, breadcrumbs, switchers, tabs | Wordmark, form, one footnote |
| Emotional job | Get out of the way | **Say what this product is** |

The second row of that last column is the unsolved problem.

---

# Open questions

*Decisions nobody has made. Each one is currently an accident of the default.*

## 13. What has been tried on the login page, and why it failed

Two attempts have been rejected. Recording both so a third does not repeat them.

**Attempt 1 — split screen.** Form on the left; on the right an animated
delivery diagram over a dot grid and a breathing accent glow, with a
feature-checklist beneath. Rejected as *"too AI made"*, correctly: that
composition is the house style of every generated SaaS login, and no amount of
craft inside it changes what the layout signals.

**Attempt 2 — Convoy-plain.** One centred column, 40px/500 headline, flat
surfaces, hairline rules, pill button, no ornament — built directly against
getconvoy.io, antigravity.google and flutter.dev. Rejected too. It is *correct*
and it is *characterless*, which is the diagnosis worth acting on: **removing
the generic decoration did not leave a brand behind, because there was never a
brand underneath it.** There is no typeface, the accent is a framework default,
and the mark is four weeks old. Restraint only reads as confidence when there is
something being withheld.

**The conclusion:** the login page cannot be fixed by another layout. It needs a
typeface, a considered colour, and a point of view about what HookuBit *is*.
That is the brief.

## 14. What branding needed to decide

1. ~~**A typeface.**~~ **Answered:** Inter + JetBrains Mono, self-hosted. §4.
2. ~~**An accent colour.**~~ **Answered:** `#4C4DDC` light / `#7E7CF5` dark. §3.
3. ~~**Warm or cool.**~~ **Answered:** cool, in both themes. §3.
4. ~~**A display scale.**~~ **Answered:** `title` 19 / `display` 23 / `hero` 34. §4.
5. **Is dark the primary theme?** An operator tool used at 2am has a real claim
   to being designed dark-first. Today dark is a mechanical inversion of light.
   The control now exists (System / Light / Dark, per device); which one it
   *defaults* to, and which one the product is *designed for*, is unanswered.
6. **The mark.** A fishing hook — eye, shank, bend, barb — in an accent square.
   Still open: the `.pen` file carries no mark of its own (its wordmark reads
   "Relay", a placeholder from another product), so nothing here supersedes it.
7. **What the sign-in page says.** Not the layout — the claim. The candidates
   from the product itself: *the record is the product*; *webhooks that arrive,
   or tell you why they did not*; *proof of every attempt*. Still open: the
   design does not answer it either.


## 15. Hard constraints on any brand

Non-negotiable for technical reasons, not taste:

- **Every colour is a CSS custom property** in `src/index.css`, as
  `R G B` triples (Tailwind composes `rgb(var(--token) / <alpha-value>)`). A
  brand palette must be expressible that way — no gradients as tokens.
- **Light and dark are one token swap.** No `dark:` variants, no second palette.
- **`data-theme` is set for dark and removed for light**, because light is
  declared on bare `:root`.
- **13px baseline in the shell.** A brand face has to survive it.
- **Two shadows, hairline separation.** A shadow-heavy brand contradicts the
  product's density.
- **No UI dependency.** The component set is hand-built; there is no library to
  re-skin.
- **Documentation site** (`apps/docs`, VitePress) and the **operator dashboard**
  share the wordmark and should share the palette; the docs site currently uses
  VitePress defaults.

## 16. What the design proposed, and what was not built

`hookubit.pen` draws 28 screens. Its **visual system** was adopted wholesale.
Its **information architecture** was not, because in several places it
describes a product with different capabilities from this one. Recorded so the
divergence is a decision rather than an oversight.

Not built, because the thing does not exist:

| In the design | Reality |
|---|---|
| Command palette (⌘K) with global search | No search endpoint, and no command palette. |
| "Export" / "Export CSV" on Events and Analytics | No export route on the control API. |
| "Send test event" | Deliberately absent: there is no test-delivery route. Publish a real event and watch its delivery. |
| Test/Production switcher in the top bar | `environment` is **immutable per project**. It is a badge, not a control; switching means a second project. |
| Billing with "Billing portal" and "Change plan" | No billing module at all. The page stays an honest empty state. |
| "Organization Selection" and "Project Selection" screens | `RootRedirect` forwards to your first org and project; switching is in the sidebar, and creating is in the switcher menu. |
| 15m / 1h / 6h time ranges | The analytics API's minimum window is 1 hour, so 15m cannot be served. The dashboard offers 24h / 7d / 30d, which map to `window_hours` 24 / 168 / 720. |
| "Replay all failed deliveries" bulk action | Replay is per delivery and per event; bulk requeue exists only for the outbox. |

Drawn by the design but absent from it, and kept: **Outbox**, **Policies**,
**Get started**, **Usage**, and the whole account flow (register, verify,
reset, accept invitation) — all real screens the design did not cover. They use
the same tokens and components, so they are consistent without having been
drawn.

Also kept: the **HookuBit** wordmark. The design's says "Relay".

---

**Where this comes from.** `apps/dashboard/tailwind.config.js`,
`apps/dashboard/src/index.css`, `apps/dashboard/src/components/`,
`apps/dashboard/src/lib/delivery-status.ts`, `apps/dashboard/src/features/auth/`,
`ARCHITECTURE.md`, and `hookubit.pen` (pen.dev, 28 screens + component library)
for everything in §3, §4 and §16. The typeface finding was measured in a running
browser, not read from configuration — before, both families fell back; after,
`Inter Variable` measures differently from an unknown family, which is how the
fix was confirmed.
