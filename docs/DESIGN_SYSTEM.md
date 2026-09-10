# HookuBit — design system

**What this is.** A description of the interface as it exists in code today,
written to be handed to a branding exercise. Everything in *The system as built*
was read out of `apps/dashboard/` and is true as of this commit; everything in
*Open questions* is a decision nobody has made yet, stated plainly so a designer
can make it rather than infer it.

**What this is not.** It is not a brand. There is no typeface, no colour anyone
chose on purpose, and no defined display type. That is the gap this document
exists to describe.

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
| `canvas` | `250 250 249` | `12 12 14` | The page. |
| `panel` | `255 255 255` | `22 22 25` | Cards, the sidebar, table surfaces, form fields on auth pages. |
| `raised` | `245 245 244` | `30 30 34` | Hover states, disabled fields, inset strips. |
| `line` | `231 229 228` | `42 42 47` | Every hairline border. |
| `line-strong` | `214 211 209` | `60 60 66` | Hover borders, scrollbar thumb. |
| `ink` | `28 25 23` | `244 244 245` | Primary text. |
| `ink-muted` | `87 83 78` | `168 166 170` | Secondary text, labels. |
| `ink-subtle` | `138 133 127` | `120 118 123` | Tertiary — hints, timestamps, footnotes. |

Note the light surfaces are **warm** (`250 250 249`, `28 25 23` — stone, not
slate) and the dark surfaces are **neutral-cool** (`12 12 14`, `244 244 245`).
That is an inconsistency nobody decided; see §14.

### Accent

| Token | Light | Dark |
|---|---|---|
| `accent` | `67 56 202` (indigo 700) | `129 140 248` (indigo 400) |
| `accent-ink` | `255 255 255` | `17 17 20` |
| `accent-soft` | `238 238 255` | `41 41 63` |

The accent carries: primary buttons, links, focus rings, the active nav item,
text selection, and the product mark. **It is Tailwind's default indigo. Nobody
chose it.** See §14.

### Status — the domain's colour vocabulary

These are not decoration. A delivery has nine states and an operator reads them
by colour before they read the word.

| Tone | Light | Dark | Means |
|---|---|---|---|
| `ok` | `21 128 61` | `74 222 128` | Succeeded. Terminal and good. |
| `warn` | `180 83 9` | `251 191 36` | Retrying. Failing, but not over. |
| `danger` | `185 28 28` | `248 113 113` | Failed, or exhausted — terminal and bad. |
| `info` | `29 78 216` | `96 165 250` | Processing. In flight right now. |
| neutral | `ink-muted` on `raised` | — | Pending, scheduled, queued, cancelled. |

Each has a `-soft` companion for badge and panel backgrounds.

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

**The scale stops at 14px.** There is no defined display size. Everything larger
in the product today is either a Tailwind default or a one-off arbitrary value
(`text-[1.625rem]`, `text-[2.5rem]`). A display scale is one of the things
branding needs to supply — see §14.

### The typeface — this is a live defect

```js
sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif']
mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
```

**Inter is declared and never loaded.** There is no `<link>` in `index.html`, no
`@font-face`, and no font package in `package.json`. Measured in the running
browser, a string set in `Inter` is exactly as wide as the same string set in a
nonexistent family — both fall through to `ui-sans-serif`.

So the product renders in whatever the operating system supplies: SF Pro on
macOS, Segoe UI on Windows, something else on Linux. **It has no typeface of its
own, and every screenshot ever taken of it is of the OS font.** This is a large
part of why the interface reads as generic, and it is the single highest-leverage
thing branding can fix.

For reference, the three sites named as inspiration all load a real face:
Convoy ships Inter; Antigravity and Flutter both ship Google Sans Flex.

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

## 14. What branding needs to decide

1. **A typeface.** The highest-leverage single decision. Must have: tabular
   figures, a usable 11px, weights ~400–600, and a monospace companion (payloads,
   signatures, IDs and headers are shown as code constantly). Self-hosted or
   properly loaded — declaring a face without loading it is the current bug.
2. **An accent colour.** Currently Tailwind indigo, unchosen, and close to the
   default of every AI-generated interface. It must survive being: a 32px solid
   button, a 2px focus ring at 70% alpha, an active-nav tint, and a 1.5px dot —
   in both themes, without colliding with the five status hues.
3. **Warm or cool.** Light surfaces are warm stone, dark surfaces are cool
   neutral. Pick one and make both themes agree.
4. **A display scale.** The type scale stops at 14px. Define 3–4 sizes above it,
   with weights and tracking, so headlines stop being arbitrary values.
5. **Is dark the primary theme?** An operator tool used at 2am has a real claim
   to being designed dark-first. Today dark is a mechanical inversion of light.
   The control now exists (System / Light / Dark, per device); which one it
   *defaults* to, and which one the product is *designed for*, is unanswered.
6. **The mark.** A fishing hook — eye, shank, bend, barb — in an accent square.
   It is legible and it is four weeks old. Whether the name's "hook" should be
   taken literally at all is open.
7. **What the sign-in page says.** Not the layout — the claim. The candidates
   from the product itself: *the record is the product*; *webhooks that arrive,
   or tell you why they did not*; *proof of every attempt*. Choosing one is a
   brand decision, and it is what attempt 2 was missing.

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

---

**Where this comes from.** `apps/dashboard/tailwind.config.js`,
`apps/dashboard/src/index.css`, `apps/dashboard/src/components/`,
`apps/dashboard/src/lib/delivery-status.ts`, `apps/dashboard/src/features/auth/`,
`ARCHITECTURE.md`. The Inter finding was measured in a running browser, not read
from configuration.
