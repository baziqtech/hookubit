# Projects

A project is the unit of delivery configuration: one environment of one
system. It owns its API keys, endpoints, subscriptions, retry and rate-limit
policies, and its events and deliveries. Nothing crosses between projects - an
endpoint id or a retry policy id from one project is simply "Resource not
found" in another.

## Environments

Every project is `test` or `live`, chosen at creation and **never changeable
afterwards**. The environment decides which API keys authenticate against the
project: a `test` project issues `wk_test_` keys and a `live` project issues
`wk_live_` keys, and the ingest path re-checks the pair on every request.
Flipping a project from test to live would silently invalidate every key under
it and start pointing production traffic at endpoints that were configured as
throwaways, so the operation does not exist. Create a second project instead.

A project created without saying otherwise is `test`, so nothing is ever made
live by omission. The environment is shown as a badge in the breadcrumb, the
project switcher and Project settings.

## Project settings

`/orgs/:orgId/projects/:projectId/settings` has these panels.

**Project** - the editable pair:

| Field | Rules |
|---|---|
| Name | 1 to 200 characters. |
| Slug | 2 to 64 characters, lowercase letters and digits joined by single hyphens. Unique within the organization. A collision is refused under the field with "A project with the slug ... already exists in this organization. Deleted projects keep their slug". |

Only what changed is sent, so re-saving an unchanged slug cannot conflict with
itself.

**Fixed** - shown as values with the reason they are fixed, never as disabled
inputs: the project id, the environment (badged `immutable`), the status,
created and last-updated times. The panel says in so many words that the
environment cannot be changed and that deleting is a separate, audited route
whose button is in the Danger zone at the foot of the page.

**Danger zone** - the last panel, with a red border: **Delete project**. See
[Deleting and suspending](#deleting-and-suspending).

**Not built yet** - a list of what has no screen: a retry policy editor (the
endpoint form can already *choose* a policy; see
[Retry and rate-limit policies](./06-retry-and-rate-limit-policies.md)), a
rate-limit editor, a payload retention setting, and transfer to another
organization.

## Creating a project

Two places open the **New project** dialog: the **Create project** button on
an organization that has no projects yet, and **New project…** at the bottom
of the project switcher in the sidebar. Both need `projects.write` (owner or
admin); for a developer, viewer or billing member the control is shown
disabled with the reason rather than hidden.

| Field | Rules |
|---|---|
| Name | Required, 1 to 200 characters. |
| Slug | Optional. Derived from the name when blank (`Rider Café Ops` becomes `rider-cafe-ops`) and returned in the response; a slug you type is validated - 2 to 64 characters, lowercase letters and digits joined by single hyphens - and never rewritten. Unique within the organization; **deleted projects keep their slug**, so a collision with one is refused under the field with the same message as a live one. |
| Environment | `test` (the default) or `live`. The dialog carries a warning that this **cannot be changed after creation** - it decides which keys (`wk_test_`/`wk_live_`) and which ingest traffic belong to the project. |

On success you land on the new project's Overview, which is where the
first-run checklist lives. Behind the dialog is
`POST /v1/organizations/:orgId/projects`, rate limited to 20 creates a minute
per address and subject to a ceiling of **100 live projects per
organization** by default (your installation's operator can raise it).
Deleted projects do not count towards the ceiling; hitting it is reported as a
limit with the numbers, never as "try again".

## Deleting and suspending

**Deleting is a soft delete**, and there is no hard delete. **Delete project**
in the Danger zone at the foot of Project settings (owner or admin; disabled
with the reason for anyone else) opens a confirmation that lists everything
below and requires you to **type the project's slug** before the button
enables. Behind it is `DELETE /v1/organizations/:orgId/projects/:projectId`,
which sets the project's status to `deleted` and returns it in that state.
Afterwards you land on the organization, which forwards to your next project.
What the deletion does:

| | Effect |
|---|---|
| The project | Disappears from every list and route in the dashboard and API. Its slug stays taken; list projects with `?status=deleted` to see it. |
| API keys | **Not revoked**, but the ingest path refuses every key whose project is not active, so publishing stops immediately. Nothing has to be undone by hand if the deletion was a mistake. |
| New events | None are accepted, so no new deliveries are created. |
| Endpoints, deliveries, attempts | Kept exactly as they are. The delivery ledger is the record of what was promised, and "did finance ever receive this?" is asked months after the thing it is about was removed. |

There is no undelete through the dashboard or API.

**Suspension** (of a project or its organization) is a platform decision, not
something you set. While suspended, members keep read access plus billing
writes, the ingest path refuses the project's keys, and the router stops
creating deliveries for its events - every candidate subscription is skipped
as `project_not_active` or `organization_not_active`, which is visible to your
installation's operator as a metric.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/settings/ProjectSettingsPage.tsx`,
`apps/dashboard/src/features/settings/IdentityForm.tsx`,
`apps/dashboard/src/features/settings/DangerZone.tsx`,
`apps/dashboard/src/features/projects/api.ts`, `CreateProjectDialog.tsx`,
`permissions.ts` (`PROJECT_WRITE_ROLES`), `apps/dashboard/src/routes/LandingRoutes.tsx`,
`apps/dashboard/src/layouts/Switchers.tsx`,
`apps/control-api/src/projects/projects.service.ts`, `projects.controller.ts`,
`dto/create-project.dto.ts`, `dto/update-project.dto.ts`, `slug.ts`,
`project-limits.ts` (`PROJECTS_PER_ORGANIZATION`, `PROJECT_CREATE_THROTTLE`),
`apps/control-api/src/authz/permissions.ts` (`permissionsUnderSuspension`),
`services/data-plane/internal/router/plan.go` (`gate`, skip reasons).
