# Accounts and teams

Who can sign in, how people join an organization, and what each role may do.

## Creating an account

Self-serve registration is **off by default**. An installation that has not
switched it on answers "Self-serve registration is disabled. Ask an
organization owner for an invitation." on the Create account page, and the
way in is an [invitation](#accepting-an-invitation).

Where it is on, the form asks for your name, work email, an organization name
("you can rename it later") and a password of at least 12 characters (up to
128). Submitting it creates your account, your first organization, and your
membership in it as **owner**, all in one step.

::: warning The confirmation never says whether the address was already taken
Registration always ends on "Check your email" whether or not the address
already had an account. That is deliberate: a different answer for a taken
address would let anyone test which emails have accounts here. If the address
was already registered, its real owner is emailed a notice that someone tried
to register with it, and nothing else happens.
:::

Registration does not sign you in. You verify your address, then sign in.

## Verifying your email

The verification link is single-use and valid for **24 hours**. Opening it
lands on a page that verifies immediately and offers a Sign in button with
your address pre-filled.

If the link has expired or was already used, the page says so and offers to
send a fresh one. You can also request a fresh link from the Create account
confirmation and from the sign-in page. Only the **newest** link works; every
earlier one is cancelled when a new one is sent. The acknowledgement is worded
"if that address has an account waiting to be verified" for the same
enumeration reason as registration.

## Signing in

Sign in with email and password. Three outcomes:

| Outcome | What you see |
|---|---|
| Correct credentials, verified address | You land on your first organization's first project (or where you were headed when the session gate sent you to sign in). |
| Unknown address, disabled account, or wrong password | "Invalid email or password." All three read identically. |
| Correct password, address never verified | "Check your email to verify this address", with a one-click resend. Your password was right; the platform refuses to open an organization for an address nobody has proved they own. |

A session lasts **7 days**. Signing out revokes the session on the server,
not just in your browser, so a copied cookie stops working too.

Sign-in is rate limited per address; sustained wrong guesses are refused with
a wait.

## Resetting a password

"Forgot password?" on the sign-in page asks for your email and always answers
"if that address has an account, a reset link is on its way". The link is
single-use and expires **1 hour** after it is issued; requesting another
invalidates the previous one.

Setting a new password (again 12 to 128 characters) **signs you out
everywhere** - every session you hold is revoked, because a reset is what you
do when you suspect a compromise. Sign in again afterwards.

## Organizations

An organization is the billing and people boundary. Members, roles and the
audit log belong to it; every project sits inside one. You can be a member of
several, with a different role in each, and the switcher at the top of the
sidebar moves between them.

**Settings** (`/orgs/:orgId/settings`) lets you rename the organization and
change its slug. The slug is 2 to 48 characters of lowercase letters and
digits joined by single hyphens, and it is unique across the whole platform:
a taken slug is refused with "That organization slug is already taken", under
the field. A rename reaches the switcher and breadcrumb immediately and
changes nothing addressed by id.

The page also shows, read-only: the organization id, its status, your role,
and the created and updated times. **Status is not self-service.** Suspension
is a platform and billing decision, and a writable status would let an
organization lift its own suspension.

### Deleting an organization

The **Danger zone** at the foot of Organization settings has **Delete
organization**. It is **owner-only** - an admin holds `projects.write`, which
the route is declared with, and is still refused by the service - and the
dashboard shows the button disabled with that reason for any other role. The
confirmation requires you to type the organization's slug, and states what
happens:

| | Effect |
|---|---|
| Projects | Every active project is soft-deleted first, then the organization, in one transaction - if anything fails, nothing changes. |
| API keys | Refused at ingest for every project at once (they are not revoked). |
| Delivery ledger, endpoints, members | Kept. The ledger's foreign keys forbid a cascade. |
| Every route under the organization | Answers 404 for every member afterwards, you included. It leaves the switcher and you land on your next organization, or an empty account. |
| Audit | `organization.deleted`, with the number of projects taken down. |

There is no undelete. Behind the button is `DELETE /v1/organizations/:orgId`.

### Creating another organization

The organization switcher at the top of the sidebar ends in **New
organization…**. The dialog takes a name and an optional slug; you become the
owner, and you land on the new organization's empty landing page, which offers
the first project. Each account may own up to 10 organizations - the dialog
reports `limit_exceeded` when you are at the ceiling - and slugs are unique
across the whole platform: a derived slug that collides is suffixed for you, a
slug you typed that collides is refused and stays as you typed it. Behind the
button is `POST /v1/organizations`.

### What suspension means

A suspended organization (or project) narrows every member to **reads, plus
billing writes**. You can still see your data and export it, and you can
still reach the payment form, because locking a customer out of paying is how
a billing suspension becomes permanent. Everything else - creating endpoints,
replaying, inviting - is refused. The platform also stops routing new events
for a suspended organization's projects.

## Team

`/orgs/:orgId/team` lists the members:

| Column | Meaning |
|---|---|
| Member | Name and email, with "(you)" on your own row. A membership whose user record is missing is shown as a data-integrity problem ("no user record") rather than hidden. |
| Role | A **select** when you may change this member's role, or the role as a badge with the sentence explaining why you may not (see [Changing roles and removing members](#changing-roles-and-removing-members)). |
| Account | Whether the account is active or disabled platform-wide. |
| Member since | How long they have been a member. |
| (actions) | **Remove**. Disabled, with the reason as its tooltip, on rows the rules below forbid. |

Every member of the organization can see this list. Inviting, changing roles
and removing members needs `members.write` (owner and admin); for every other
role the Role column is read-only and Remove is disabled.

### Inviting someone

**Invite member** asks for an email and a role. Every role is listed, and the
ones above your own rank are greyed out: an owner may invite an owner (it is
the only way a second owner comes to exist); an admin may invite an admin but
not an owner.

The confirmation reads "If *address* can receive mail, an invitation is on
its way. They will appear in this list once they accept it." That wording is
literal on three counts:

- The answer is the same whether the address is unknown, already has an
  account, or is already a member of this organization. (An address that is
  already a member is emailed an "already a member" notice instead of an
  invitation.)
- **No member row exists until the invitation is accepted.** There is no
  "pending" state in the list.
- Invitations expire **7 days** after they are sent and can be used once.

One mailbox can be sent at most 20 invitations an hour, across every
organization on the platform, so one member cannot use the platform as a
mail cannon.

### Accepting an invitation

The invitation email links to `/accept-invitation?token=...`. What happens
depends on whether you are signed in:

| You are | What the page does |
|---|---|
| Signed out | Offers Sign in (which returns you to this link afterwards) and Create account. If you create an account, use the invited address, verify it, then open the link again. The link stays valid until it is used or expires. |
| Signed in | Shows "Accept this invitation?" naming the account you are signed in as, with **Accept as *address*** and **Not you? Sign out and come back to this link**. Nothing is redeemed until you press Accept, so signing out from here keeps the link usable. |

::: danger Accepting from the wrong account uses the invitation up
An invitation is tied to the address it was sent to. When you press Accept,
the platform **consumes the token first** and only then checks that the
signed-in address matches, that the organization is still active, and that
the person who invited you is still a member who outranks the role they
offered. If any of those fail, the token is already spent and cannot be
retried: the page says "This invitation cannot be used" (or "cannot be
completed" when the organization or inviter no longer supports it) and the
only way forward is a new invitation. So if the card names an account other
than the one the email went to, sign out first.
:::

Accepting an invitation to an organization you already belong to returns
your existing membership unchanged; the page cannot tell "joined" from "was
already in".

On success the page says "You are a member of *organization*" with your role,
and offers to open it.

## Roles and permissions

There are five roles. Permissions are explicit, never inferred, and the table
below is generated from the platform's own permission matrix.

| Role | Intended for |
|---|---|
| Owner | Everything, including deleting the organization and billing. |
| Admin | Everything except billing payments. Manages the team and projects. |
| Developer | Owns everything inside a project - endpoints, subscriptions, policies, API keys, replay - but cannot create or delete projects or change the team, and cannot read signing secrets. |
| Viewer | Read-only on delivery data. Cannot see the API key inventory, cannot replay, cannot read the audit log. |
| Billing | Money and seats: billing, the member list, and enough project visibility to understand a usage line. Sees no events, deliveries or endpoints. |

| Permission | Owner | Admin | Developer | Viewer | Billing |
|---|:---:|:---:|:---:|:---:|:---:|
| `projects.read` | Yes | Yes | Yes | Yes | Yes |
| `projects.write` | Yes | Yes | - | - | - |
| `endpoints.read` | Yes | Yes | Yes | Yes | - |
| `endpoints.write` | Yes | Yes | Yes | - | - |
| `endpoint-secrets.read` | Yes | Yes | - | - | - |
| `endpoint-secrets.write` | Yes | Yes | - | - | - |
| `subscriptions.read` | Yes | Yes | Yes | Yes | - |
| `subscriptions.write` | Yes | Yes | Yes | - | - |
| `api-keys.read` | Yes | Yes | Yes | - | - |
| `api-keys.write` | Yes | Yes | Yes | - | - |
| `events.read` | Yes | Yes | Yes | Yes | - |
| `events.replay` | Yes | Yes | Yes | - | - |
| `deliveries.read` | Yes | Yes | Yes | Yes | - |
| `deliveries.replay` | Yes | Yes | Yes | - | - |
| `policies.read` | Yes | Yes | Yes | Yes | - |
| `policies.write` | Yes | Yes | Yes | - | - |
| `members.read` | Yes | Yes | Yes | Yes | Yes |
| `members.write` | Yes | Yes | - | - | - |
| `audit.read` | Yes | Yes | - | - | - |
| `billing.read` | Yes | Yes | - | - | Yes |
| `billing.write` | Yes | - | - | - | Yes |

Three rows are worth reading twice:

- **`endpoint-secrets.*` is owner and admin only**, and it is not implied by
  `endpoints.read`. A signing secret authenticates every outbound call made on
  your behalf; whoever holds it can forge a webhook into your own consumers.
  This is why an endpoint created by a developer starts paused - see
  [Endpoints](./04-endpoints.md#who-sees-the-secret-decides-whether-it-goes-live).
- **Viewers cannot replay.** A replay puts real HTTP traffic on a consumer;
  it is a write with side effects outside this system.
- **`audit.read` is owner and admin.** The log carries other members'
  actions, IP addresses and user agents.

Deleting an organization is owner-only even though the table has no row for
it; it is checked separately.

### Changing roles and removing members

Roles form a ladder: owner above admin above developer, with viewer and
billing on the bottom rung side by side. The rules, all enforced by the
platform:

- You cannot change your own role, and you cannot remove yourself. Ask
  another owner or admin.
- You cannot assign a role above your own, and you cannot change or remove a
  member who outranks you. An admin can make another admin but cannot demote
  an owner.
- **An organization must always have at least one owner.** Demoting or
  removing the last owner is refused with "An organization must always have
  at least one owner. Promote another member first." The count is taken in
  the same transaction as the change, so two people demoting two owners at
  once cannot leave zero.
- An invitation is checked against the inviter's rank at the moment it is
  accepted, not the moment it was sent. If the inviter has been demoted below
  the role they offered, the acceptance fails (and consumes the token).

Removing a member deletes the membership row. The audit trail naming them
survives. API keys they created keep authenticating for ingest but lose all
control-plane authority - see [API keys](./03-api-keys.md#scopes-and-effective-scopes).

#### On the Team page

The dashboard mirrors these rules so a control explains itself before it is
touched, and shows the platform's own sentence when it refuses anyway:

| You try to | What you see |
|---|---|
| Change a role | Pick the new role in the row's select. Nothing changes until you confirm: the dialog names the member, the change, and its consequences (promoting to owner puts them beyond an admin's reach; demoting an owner is subject to the last-owner rule). |
| Change your own role, or the role of someone who outranks you | The Role column is a badge, with the reason beneath it: "You cannot change your own role. Ask another owner or admin to do it." / "You may not change the role of an owner." |
| Pick a role above your own rank | The option is greyed out in the select. |
| Remove a member | **Remove** opens a confirmation stating that the membership is deleted immediately, that the audit entries naming them survive, and what happens to the API keys they created. |
| Remove yourself, or someone who outranks you | Remove is disabled; the reason is its tooltip. |
| Demote or remove the last owner | The confirmation says the platform counts owners in the same transaction and refuses if this would leave none. The refusal, "An organization must always have at least one owner. Promote another member first.", is shown in the dialog. |

The same operations through the API are `PATCH` (with `{ role }`) and
`DELETE` on `/v1/organizations/:orgId/members/:memberId`.

---

**Where this comes from** (for maintainers):
`apps/dashboard/src/features/auth/*` (RegisterPage, LoginPage, VerifyEmailPage,
ResendVerification, ForgotPasswordPage, ResetPasswordPage),
`apps/dashboard/src/features/team/TeamPage.tsx` and `lattice.ts` (the client-side
mirror of the role lattice), `apps/dashboard/src/features/organizations/api.ts`
(`useUpdateMemberRole`, `useRemoveMember`),
`apps/dashboard/src/features/team/AcceptInvitationPage.tsx`,
`apps/dashboard/src/features/settings/OrganizationSettingsPage.tsx`,
`apps/dashboard/src/features/settings/DangerZone.tsx`,
`apps/dashboard/src/features/projects/permissions.ts` (`ORGANIZATION_DELETE_ROLES`),
`apps/dashboard/src/features/organizations/api.ts` (`useDeleteOrganization`),
`apps/control-api/src/auth/auth.service.ts` and `auth.controller.ts`,
`apps/control-api/src/auth/token.service.ts` (`TOKEN_TTL_MS`),
`apps/control-api/src/auth/session.service.ts` (`SESSION_TTL_SECONDS`),
`apps/control-api/src/auth/password.service.ts` (`MIN_LENGTH`, `MAX_LENGTH`),
`apps/control-api/src/config/env.schema.ts` (`ALLOW_OPEN_REGISTRATION`),
`apps/control-api/src/members/members.service.ts`, `members.controller.ts`,
`invitations.controller.ts`, `apps/control-api/src/organizations/organizations.service.ts`
(`MAX_ORGANIZATIONS_PER_USER`), `apps/control-api/src/authz/permissions.ts`
(the matrix table above is generated from `GRANTS`; `ROLE_RANK`,
`assertRoleChangeAllowed`, `assertMemberRemovalAllowed`, `permissionsUnderSuspension`).
