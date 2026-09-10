# Dashboard

The hookubit dashboard is the operator surface: the place a team lead, an
integration engineer or the person on call goes to set a project up, to see
what happened to an event, and to put things right when a consumer is down.
Everything it shows is read live from the control API; nothing on it is a
cached summary that can disagree with the rows underneath.

This section is written for the people who administer and operate hookubit
through the dashboard. The API reference under [API reference](/api/) covers
the same operations for scripts and integrations, and the
[Guide](/guide/04-receiving-webhooks) covers what your consumer has to do.

## What lives where

hookubit has a three-level hierarchy, and it is in the URL:

```
/orgs/:orgId                                   organization landing (forwards to a project)
/orgs/:orgId/settings                          organization name and slug
/orgs/:orgId/team                              members and invitations
/orgs/:orgId/billing                           not built yet
/orgs/:orgId/usage                             30-day events and deliveries per project
/orgs/:orgId/audit                             audit log

/orgs/:orgId/projects/:projectId/get-started   setup checklist and first request
/orgs/:orgId/projects/:projectId/overview      health once setup is complete
/orgs/:orgId/projects/:projectId/events        everything published
/orgs/:orgId/projects/:projectId/events/:id    one event and its fan-out
/orgs/:orgId/projects/:projectId/deliveries    one row per event per endpoint
/orgs/:orgId/projects/:projectId/deliveries/:id one delivery and its attempts
/orgs/:orgId/projects/:projectId/outbox        what the router still owes, and what it gave up on
/orgs/:orgId/projects/:projectId/endpoints     the URLs you deliver to
/orgs/:orgId/projects/:projectId/subscriptions the routing rules
/orgs/:orgId/projects/:projectId/policies      retry policies and rate limits
/orgs/:orgId/projects/:projectId/api-keys      publishing credentials
/orgs/:orgId/projects/:projectId/analytics     outcomes, failing endpoints, latency, volume
/orgs/:orgId/projects/:projectId/settings      project name and slug
```

Tenancy is in the path on purpose. Every screen is linkable, and a URL pasted
into an incident channel lands the next person on exactly what you were
looking at, filters included. There is no "current project" held anywhere
else.

| Level | What it is | Owns |
|---|---|---|
| Organization | The billing and people boundary | Members, roles, the audit log |
| Project | One environment of one system (`test` or `live`) | API keys, endpoints, subscriptions, retry and rate-limit policies, events, deliveries |
| Endpoint | A URL the platform delivers to | Its signing secrets, its own concurrency, rate limit and circuit breaker |

## Finding your way around

- **Sidebar.** The organization and project switchers are at the top. Below
  them, the project navigation (Get started, Overview, Events, Deliveries,
  Outbox, Endpoints, Subscriptions, Policies, API keys, Analytics, Settings)
  and the organization navigation (Settings, Team, Billing, Usage, Audit log). The
  Product tour button and your account menu (with Sign out) are at the bottom.
- **Breadcrumb.** `Organization / Project / Section` across the top. The
  project crumb carries a `test` or `live` badge so you always know which
  environment you are about to change something in.
- **Switchers show one page.** If an organization has more projects than fit
  in the menu, the menu says so rather than silently listing the first page.
  Switching project always lands on that project's Overview.
- **Get started carries a dot** while a project cannot yet deliver a webhook.
  It clears itself when setup is complete. See [Onboarding](./09-onboarding.md).

Signing in lands you on your first organization's first project. If your
account is not a member of any organization yet you see "No organizations";
an invitation is the way in. See [Accounts and teams](./01-accounts-and-teams.md).

## Conventions that hold on every page

**Lists are paged, and the pager tells the truth.** Every table shows 50
rows a page (the API allows up to 200). The pager is present even when there
is one page, and it says "more not shown" when the server holds more. This
matters most on API keys and endpoints: "have I revoked everything that can
authenticate as us?" is only answerable if the list says whether it is
complete.

**Filters live in the URL.** Change a filter and the address bar changes with
it, so a filtered view can be shared.

**Timestamps are UTC.** Relative times ("14 minutes ago") carry the absolute
time as a tooltip.

**Failures are told apart.** A write can be refused for four different
reasons and the dashboard words each differently, because the remedies are
opposites:

| What you see | What it means | What to do |
|---|---|---|
| "Too many requests, slow down" | You hit a rate limit on this action. The panel says how long to wait. | Wait; nothing was created. |
| "You have reached a limit" | A ceiling (projects per organization, endpoints per project, and so on). Waiting never helps. | Delete something you no longer need, or ask your installation's operator to raise the limit. |
| "That conflicts with something that already exists" | A duplicate slug, a deleted endpoint, an endpoint with no live signing secret. | Read the sentence; it names the conflict. |
| "Check the details and try again" | Validation. Each rejected field is marked under its own input. | Fix the field. |
| "You cannot ..." | Your role in this organization does not allow it. The panel names the roles that can, your role, and a `request_id` for support. | Ask an owner or admin. |

A resource that does not exist and a resource that belongs to another
organization both answer "Resource not found". The dashboard never confirms
that an id you were not given is real.

**Credentials are shown once.** An API key and an endpoint signing secret
appear exactly once, in the dialog that created them, with a copy button.
Only a hash is stored; nobody, including support, can show the value again.
Lose it and you revoke (or rotate) and re-issue.

**A red "Demo data" bar** across the top means the build you are looking at
is wired to an in-browser mock, not to a control API. Every number on it is
fabricated. It has no dismiss control; it disappears when the dashboard is
built against the real API.

## Reading order

| # | Page | Read it when |
|---|---|---|
| 01 | [Accounts and teams](./01-accounts-and-teams.md) | You are creating an account, inviting someone, or need to know who can do what. |
| 02 | [Projects](./02-projects.md) | Before creating a second project, and before deleting one. |
| 03 | [API keys](./03-api-keys.md) | You are wiring a publisher up, or auditing what can authenticate as you. |
| 04 | [Endpoints](./04-endpoints.md) | You are adding a consumer, or an endpoint shows `disabled`, `paused` or `auto-disabled`. |
| 05 | [Subscriptions](./05-subscriptions.md) | You are deciding which events go where, or an event was accepted and nothing arrived. |
| 06 | [Retry and rate-limit policies](./06-retry-and-rate-limit-policies.md) | You need a consumer retried differently, or throttled. |
| 07 | [Events and deliveries](./07-events-and-deliveries.md) | It is 2am and someone asks "did finance ever receive this?" |
| 08 | [Analytics, usage and audit](./08-analytics-usage-and-audit.md) | You want the trend, or you need to know who paused an endpoint and why. |
| 09 | [Onboarding](./09-onboarding.md) | You are new, or you are onboarding someone. |
| - | [Glossary](./glossary.md) | A word on a screen is doing work you do not recognise. |

---

**Where this comes from** (for maintainers; the reader does not need these):
`apps/dashboard/src/routes/router.tsx`, `apps/dashboard/src/layouts/navigation.ts`,
`apps/dashboard/src/layouts/AppLayout.tsx`, `apps/dashboard/src/layouts/Switchers.tsx`,
`apps/dashboard/src/routes/LandingRoutes.tsx`, `apps/dashboard/src/components/Pager.tsx`,
`apps/dashboard/src/lib/api-errors.ts`, `apps/dashboard/src/components/PermissionDenied.tsx`,
`apps/dashboard/src/components/DemoDataBanner.tsx`, `apps/dashboard/src/types/api.ts`
(`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`), `apps/control-api/src/authz/tenant-resolver.service.ts`
(`CROSS_TENANT_MESSAGE`).
