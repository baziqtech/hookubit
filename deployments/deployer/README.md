# Deploying HookuBit to a bare-metal Ubuntu server

This is [apps/docs/self-hosting/09-bare-metal-ubuntu.md](../../apps/docs/self-hosting/09-bare-metal-ubuntu.md),
automated. The guide is still the explanation; this is the procedure that runs.

```
make deploy                 # the whole thing
dep list                    # every task
dep hookubit:preflight       # config + git staleness. Connects to nothing
dep hookubit:verify          # read-only checks against the live host
dep hookubit:health          # just the health check
dep hookubit:dashboard:check # is nginx serving THIS release?
dep rollback                 # READ "Rollback" below first
```

Deployer is PHP, but nothing PHP runs on the server and the server needs neither
PHP nor Composer. It is here for three things a shell script does not give us:
a release directory per deploy, an atomic `current` symlink swap, and a rollback
that is one command.

## Files

| Path | What it is |
|---|---|
| `../../deploy.php` | Entry point. `dep` finds it in the repo root. |
| `hookubit.php` | All tasks, and the long comment explaining the ordering. |
| `hosts.yml` | **The only file you edit.** Hostname, user, domain, ingest URL. |
| `systemd/*.service` | The two units, corrected to point at `current/`. |
| `sudoers.d/hookubit-deploy` | The six privileged commands a deploy needs. |

## One-time server setup

Follow §1–§5 and §8–§12 of the guide — database, Redis, toolchain, env file,
nginx, Cloudflare, first account. Three things differ from the guide, because
the guide predates this layout:

**1. Two users, not one.** The guide builds as the `hookubit` service user in
`/opt/hookubit/src`. Here the deploy user writes the releases and the service
user only reads them, so a compromised service process cannot rewrite the code
it runs.

```bash
sudo useradd --system --home-dir /var/lib/hookubit --create-home \
     --shell /usr/sbin/nologin hookubit
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG hookubit deploy
sudo usermod -aG systemd-journal deploy      # so the deploy can read the logs

sudo mkdir -p /opt/hookubit
sudo chown deploy:hookubit /opt/hookubit
sudo chmod 2755 /opt/hookubit                # setgid: releases stay group-hookubit
```

Put your public key in `/home/deploy/.ssh/authorized_keys`, and a read-only
GitHub deploy key in `/home/deploy/.ssh/` — the server clones the repository, not
your laptop.

**`2755`, not `2750`, and the `5` for *other* is load-bearing.** nginx workers
run as `www-data`, which is in neither `deploy` nor `hookubit`. With `2750`
they have no search bit on the first path component of
`/opt/hookubit/current/apps/dashboard/dist`, cannot open `index.html`, and
**every visitor gets 403** — while `/v1/*` keeps working, because that is
proxied rather than served from disk, and while the deploy reports success,
because the health probes hit `127.0.0.1:3000` and `:9090` directly and never
go through nginx. `hookubit:dashboard:check` is what now catches it.

The alternative was `sudo usermod -aG hookubit www-data`. **Don't.**
`/etc/hookubit/hookubit.env` is `0640 root:hookubit` (next section), so putting
nginx in that group hands the web server read access to `ENCRYPTION_KEY`, the
database password and every other secret on the box. Widening a directory that
contains only built assets — which nginx serves to the public anyway — is the
far smaller grant.

One corollary: the deploy user's umask has to leave world-read on, which the
Ubuntu default `022` does. A `027` umask in `/home/deploy/.profile` puts the 403
back one release directory down, where `chmod` on `/opt/hookubit` will not help.

**2. The env file is group-readable.** `prisma migrate deploy` runs as the deploy
user and needs `DATABASE_URL` and `DIRECT_DATABASE_URL`:

```bash
sudo chown root:hookubit /etc/hookubit/hookubit.env
sudo chmod 0640 /etc/hookubit/hookubit.env
```

The trade: the deploy user can read every secret in that file, `ENCRYPTION_KEY`
included. That is the price of not granting it a broad `sudo -u hookubit`, which
would be strictly worse — an attacker with the deploy key could then run
anything as the service user. The deploy user is a trusted identity; treat its
SSH key like the env file itself.

The recipe reads only those two keys, with `sed`, and never sources the file.
It cannot: `MAIL_FROM=HookuBit <no-reply@example.com>` is valid for systemd's
`EnvironmentFile` and a redirection to `/bin/sh`.

Reading it the way systemd does takes three more steps that a bare
`sed -n 's|^KEY=||p'` skips, and each of them would otherwise hand Prisma a
connection string that cannot connect: surrounding quotes (`DATABASE_URL="..."`
is valid, and systemd strips them), a trailing `\r` from a CRLF file, and
trailing blanks. The `hb_env` helper in `hookubit.php` strips all three, and
takes the **last** definition of a repeated key, which is also systemd's rule.

**Each value must be on one physical line.** systemd joins a value whose line
ends in a backslash with the next line; `hb_env` reads one line, and a connection
string cut at the backslash usually still parses — so the services and the
migration would quietly use *different* databases. Rather than differ in silence,
`hb_env` refuses such a value, and `hookubit:toolchain` checks the whole file up
front and names the key (never the value, which carries the password).

**3. Install the units and the sudoers file by hand.**

```bash
sudo install -m 0644 -o root -g root systemd/hookubit-api.service        /etc/systemd/system/
sudo install -m 0644 -o root -g root systemd/hookubit-data-plane.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hookubit-api hookubit-data-plane    # enable, do not start

sudo install -m 0440 -o root -g root sudoers.d/hookubit-deploy /etc/sudoers.d/hookubit-deploy
sudo visudo -c -f /etc/sudoers.d/hookubit-deploy
```

The deploy does not install these: writing to `/etc/systemd/system` is a root
file write. Be precise about what keeping it out buys, because it is **not**
"a stolen deploy key cannot redefine what runs" — it can. The deploy user owns
the release tree and the `current` symlink, so it can write any binary to
`current/bin/webhookd` and `sudo systemctl restart` straight into it. What the
exclusion actually buys:

- **No path to root.** A writable unit file is arbitrary code as root on the
  next start. Without it the blast radius stays inside the two service users.
- **The user and the hardening are fixed.** `User=`, `Group=`,
  `NoNewPrivileges=`, `ProtectSystem=`, `ReadWritePaths=` and the rest are
  root-owned and out of reach, so whatever the deploy user manages to run still
  runs as `hookubit`, confined, and not as root.

`daemon-reload` is excluded for the same reason, and because no task calls it:
installing or editing a unit is the by-hand root step, and that is the step that
reloads. `hookubit:systemd:check` fails the deploy if either unit is missing or
does not reference `current/`.

**4. Point nginx at the release.** The guide serves the dashboard from
`/opt/hookubit/web` and rsyncs into it. With a release layout that copy is
redundant — and a second thing to keep in step. In
`/etc/nginx/sites-available/hookubit`:

```nginx
root /opt/hookubit/current/apps/dashboard/dist;
```

nginx resolves that symlink per request (`open_file_cache` is off by default), so
the symlink swap publishes the new bundle with no reload. Keep the rest of the
guide's §8 exactly as it is, including `Cache-Control: no-store` on
`index.html` — without it a deploy leaves browsers on a stale bundle requesting
asset filenames that no longer exist.

This is the half of the platform systemd does not start, and the deploy's health
probes do not touch it: they go to `127.0.0.1:3000` and `127.0.0.1:9090`
directly. Leave nginx on the guide's `root /opt/hookubit/web` and you get a
green deploy and a bundle that never changes again, for ever.
`hookubit:dashboard:check` narrows that: it takes the content-hashed filename of
the **entry module** out of the release's own `index.html` and requires it in
what `https://<app_domain>/` actually returns, so a 403, a stale `root`, or a
cache in front fails the deploy instead of being discovered by a user. The entry
module specifically, because Vite hashes per chunk: a stylesheet that did not
change keeps its name across releases, so anchoring on "any referenced asset"
would pass on a bundle whose JavaScript was a release old.

It **narrows**, not closes: a deploy that changes only the Go side leaves the
entry hash unchanged, so an nginx still rooted at `/opt/hookubit/web` passes that
deploy and is caught only at the next deploy that touches the dashboard.
Detection is deferred, not lost — and `/opt/hookubit/web` is a one-time
misconfiguration, so the first dashboard change after it finds it.

It fetches the **public** hostname, which the server itself has to resolve and
reach. Split-horizon DNS, a Cloudflare-only record or an egress rule all break
that without anything being wrong with the deploy, so it is overridable:

```
dep deploy -o dashboard_check_url=https://hookubit.lan/   # same vhost, reachable
dep deploy -o skip_dashboard_check=true                   # and then look yourself
```

Both are ordinary config overrides, not deploy-only: the same flags work on
`dep hookubit:verify` and `dep hookubit:dashboard:check`.

Prefer an internal name over plain `127.0.0.1`, which may answer from a
different server block and so prove nothing.

## What a deploy does, in order

1. **`hookubit:preflight`** — local only, no connection. Validates `hosts.yml`
   and refuses stale code.
2. **`deploy:setup` … `deploy:writable`** — new release directory, code from the pushed
   ref. Deployer's stock `deploy:prepare` group is spelled out instead of invoked so
   that `deploy:env` is left out: it would copy this repo's 12 KB `.env.example`
   to `.env` in every release, and configuration lives in the env file systemd
   loads.
3. **`hookubit:toolchain` / `hookubit:systemd:check`** — Node ≥ 20, Go, pnpm, the
   env file and both database URLs, and units that point at `current/`.
4. **`hookubit:build`** — `pnpm install --frozen-lockfile`, `pnpm generate`
   (installing alone does not produce the Prisma client), the control API, the Go
   binary into `<release>/bin/webhookd`, then the dashboard.
5. **`hookubit:migrate:status`** — prints every pending migration and stops to
   ask if one of the two ordering exceptions is among them. It captures Prisma's
   exit code and refuses on any output it cannot positively classify: "could not
   tell" must not read as "nothing pending", because that is the one line you use
   to decide whether the exceptions are in play. It then **compares
   `_prisma_migrations` against the release's own migration directories** and
   refuses if the database is ahead — see "Deploying an older ref" below. The
   reassuring "already at this revision" line is not printable until that
   comparison has been made.
6. **`hookubit:data-plane:stop`** — the part the naive order gets wrong.
7. **`hookubit:migrate:deploy`** — from the new release.
8. **`deploy:symlink`** — the atomic swap.
9. **`hookubit:api:restart`**, **`hookubit:data-plane:start`**.
10. **`hookubit:health`** — `/health/live` on the control API, `/health/ready` on
    the data plane's `:9090`. Retries for a minute, then fails loudly with the
    journal.
11. **`hookubit:dashboard:check`** — fetches `https://<app_domain>/` and requires
    the HTML to reference an asset this release built. Skippable with
    `-o skip_dashboard_check=true`; see "Point nginx at the release" above.
12. `deploy:unlock`, `deploy:cleanup`, `deploy:success`.

### The two values compiled into the dashboard

`VITE_API_TRANSPORT=http` and `VITE_INGEST_BASE_URL` are baked into the bundle at
build time and cannot be changed afterwards. Without the first, the dashboard
runs its in-memory mock: every screen works, against data that does not exist.
A wrong second value tells people to publish to someone else's host.

They come from `hosts.yml`. `hookubit:config:validate` refuses an empty, placeholder,
non-`https`, or localhost value **before the build starts**, and after the build
`hookubit:build:dashboard` greps the emitted JavaScript for the configured
origin and for the `http://localhost:8080` fallback. A bundle that does not
contain the one, or does contain the other, fails the deploy instead of shipping.

Both greps run `--include='*.js' --exclude='*.js.map'`, and **the option order
matters.** `vite.config.ts` sets `sourcemap: true`, so
`dist/assets/*.js.map` always carries the original source line

```js
return import.meta.env.VITE_INGEST_BASE_URL ?? 'http://localhost:8080'
```

whether or not the fallback was taken — so a map file in scope makes the
negative check fire on every deploy, with a message saying the opposite of the
truth. `--include='*.js'` alone already keeps it out of scope: `*.js.map` does
not match `*.js`, and the negative check exits 1 with no `--exclude` at all. The
`--exclude` is belt-and-braces against a future `--include` that is widened, not
the thing holding this up.

What genuinely is load-bearing is the **option order**: the filters have to come
*before* the pattern. In `grep -rqF -- PATTERN --include='*.js' dir` the `--`
ends option parsing, so `--include='*.js'` becomes a filename operand, grep exits
2 complaining that no such file exists, and the filter never applies at all.

### Why the data plane is stopped across the migration

Two migrations invert the usual "apply ahead of the code" rule, and both fail
silently when the order is wrong:

- **`20260911000000_next_attempt_at_not_null`** — applied while an older worker
  is alive, every terminal transition from that worker fails its `UPDATE`, the
  attempt row rolls back with it, and the delivery sits in `processing` until its
  lease expires and it is retried against an endpoint that **already received
  it**.
- **`20260923000000_rename_fan_out_to_routing`** — `event_outbox.fan_out_cursor`
  becomes `routing_cursor` with no overlap. An older router's claim query fails
  at parse time and **stops draining the outbox entirely**, while ingest, which
  does not name the column, keeps answering `202 Accepted`. Publishers see
  success, nothing is delivered, and the backlog is invisible on the events page.

Stopping the data plane across the migration satisfies both: no old worker is
alive to have its `UPDATE` rejected, and no old router is alive to parse the old
column name. It costs a short pause in delivery, which on a home server is the
right trade — the queue is PostgreSQL, so an unclaimed delivery is a delivery
still waiting.

One thing the recipe will not do for you: on a **large** `deliveries` table, the
`next_attempt_at` migration wants the hand-run recipe in its own header (one
transaction per step, `lock_timeout = '5s'`, `CREATE INDEX CONCURRENTLY`) because
Prisma wraps the whole file in a single transaction and the lock-avoiding idiom
degrades to a full-table scan under an exclusive lock. Run those steps by hand
first; the migration then finds its work done and does nothing.

## Refusing stale code

Deployer deploys a pushed git ref, so a dirty working tree is not the risk — it
simply is not deployed, and the recipe says so and carries on. The risks are
deploying a ref that is **behind** your tree, or local commits that were **never
pushed**. `hookubit:guard:ref` resolves `refs/heads/<ref>` and `refs/tags/<ref>`
with **separate** `git ls-remote` calls (and peels an annotated tag through
`refs/tags/<ref>^{}` to the commit), then:

| Situation | What happens |
|---|---|
| Remote ref missing | **Refuses.** Push the branch or tag first. |
| `X` exists as both a branch and a tag | **Refuses**, printing both SHAs. git advertises `refs/heads/` first, so resolving them together would have silently pinned the *branch* tip — breaking the one invariant a `--tag` deploy relies on. |
| Remote behind local | **Refuses**, and lists the unpushed commits. |
| Remote ahead of local | Warns and asks — you would deploy commits you have not read. |
| Diverged | **Refuses.** |
| Remote ref not in your object store | **Refuses.** `git fetch` and look. |
| Explicit `--revision` | **Refuses** without an override; there is no branch to compare. |
| Working tree dirty | Prints `git status --porcelain` as a note. Not an error. |

It then **pins** the deploy to the commit it approved, so the remote moving
between the guard and `deploy:update_code` cannot change what ships. Override the
whole guard with `-o allow_stale_ref=true` when you mean it.

## Health, and what a failure means

`hookubit:health` polls both probes every two seconds for a minute. `/health/ready`
on the data plane distinguishes two PostgreSQL stories that look identical from a
dashboard, and the recipe names which one you have:

| Body | Means |
|---|---|
| `"postgres":"connecting"` | The pool has **never** been opened. `DATABASE_URL`, `pg_hba.conf`, or the firewall. Not a blip. |
| `"postgres":"down"` | A pool was opened and **lost**. The database host or the network went away; the data plane retries on a backoff rather than exiting. |
| `"status":"starting"` | The probe port is bound but readiness never flipped — it has not reached the database yet. |
| `"status":"draining"` | It is shutting down. Look for a crash loop. |

On failure the recipe prints 30 journal lines for each unit and then tells you
what to run. **It does not roll back automatically**, and the choice is
deliberate: after the symlink swap the database has already moved, and swapping
the symlink back is how you get old code onto a new schema. What it does do:

- **Failed before anything was stopped** — the live release is untouched. The
  half-built release is left for inspection.
- **Failed after the data plane was stopped, before the swap, with no migrations
  applied** — the data plane is started again automatically. Nothing changed.
- **Failed after the data plane was stopped, before the swap, with migrations
  applied** — the data plane is **left down on purpose**, because the live
  release is now old code against a new schema. Starting it would look like
  recovery and deliver nothing. Fix and re-run `make deploy`;
  `prisma migrate deploy` is idempotent.
- **Failed after the swap** — the release is live and unhealthy. You get the exact
  commands for rolling forward, restarting in place, or rolling back. If the
  failure was in `hookubit:api:restart`, so `hookubit:data-plane:start` never
  ran, it says that too, in capitals: **nothing is being delivered right now**,
  and ingest keeps answering `202` the whole time. If both probes passed and it
  was `hookubit:dashboard:check` that failed, it says that instead, so you do
  not go reading the journal for a service that is fine.

## Rollback

> **`dep rollback` swaps the symlink. The database does not roll back.**
> This platform ships no down-migrations, by design.

So a rollback across a schema change runs **old code against a new schema**.
Across `20260923000000_rename_fan_out_to_routing` that specifically means the
router stops draining the outbox **silently**: the old binary looks for
`fan_out_cursor`, the column is `routing_cursor`, ingest keeps answering `202`,
and nothing is delivered. Rename it back by hand **first**:

```sql
ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;
```

And across `20260911000000_next_attempt_at_not_null`, drop the constraint first,
or terminal transitions from the older worker fail and already-delivered events
are retried:

```sql
ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;
```

`hookubit:rollback:before` prints all of this and then **compares directly**:
`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`
against the migration directories in the release you are rolling back to. Any
applied name that is not on disk is drift, and if it is one of the two
exceptions it prints the exact statement you have to run by hand first. A row
with `finished_at IS NULL` and no `rolled_back_at` is a **failed** migration, and
it forces the could-not-prove path rather than quietly dropping out of the
comparison.

It does not parse Prisma's prose, because Prisma cannot answer this question.
The phrases an earlier version of this recipe matched on do not exist anywhere
in Prisma 5.22's CLI, and — worse — the case that matters prints nothing at all:
when the local `prisma/migrations` is a strict *prefix* of what is applied,
which is exactly a rollback, the diagnostic is `migrationsDirectoryIsBehind`,
which `migrate status` does not handle. It falls through to
`Database schema is up to date!` and exits 0.

**The default is drift.** If the probe cannot run — no `@prisma/client` in that
release, an empty `DIRECT_DATABASE_URL`, an unreachable database — it says
`COULD NOT PROVE THE DATABASE IS NOT AHEAD` and treats that as drift, because
this is the line you read while deciding whether to hand-run an `ALTER TABLE`,
and a false green there is how `dep rollback` reports success while the old
router silently stops draining the outbox. It refuses without an explicit yes
either way. `hookubit:rollback:after` restarts both services and health-checks — without
that the symlink points at the old release while the processes keep running the
new code, which is worse than no rollback because it reports success.

If the rollback itself fails part-way — after the data plane is stopped and
before the restart — `fail('rollback', 'hookubit:rollback:failed')` reports the
half-state: which release `current/` actually points at, and whether
`hookubit-data-plane` is up. It starts the data plane again when the release that
is live is the one this schema matches, and says in capitals that it is **down**,
with why, when it is not. Without it the run stops at the first non-zero task,
`after('rollback', ...)` never runs, and you are left with the symlink mid-swap,
the data plane down, ingest still answering `202`, and a raw Deployer exception
that says nothing about delivery having stopped.

**Rolling forward is almost always better.** Rollback is for "the new code is
broken and the schema did not move".

### Deploying an older ref

`dep deploy --tag v1.3.0` is the documented way to put an older release back
after a bad one — so it is a **recovery path**, not an unlikely accident, and it
walks into the same trap from the other side.

The release's `prisma/migrations` is then a strict *prefix* of what is applied,
which Prisma 5.22 classifies `migrationsDirectoryIsBehind` — a diagnostic
`migrate status` has **no handler for**. It falls through to
`Database schema is up to date!` and exits 0. So without a second question the
deploy goes fully green: no migrations pending, `hookubit_schema_changed` false,
symlink swapped, the **old** router started, and **both health probes 200**,
because readiness opens a pg pool and never runs the router's claim query. The
router then cannot parse `fan_out_cursor`, ingest keeps answering `202`, and
nothing is delivered. Worse, if anything else fails, the failure handler would
have said "this deploy applied no migrations, so a rollback is comparatively
safe".

So `hookubit:migrate:status` runs the same direct comparison
`hookubit:rollback:before` does — one extra `node` round trip — and **refuses**
when any applied migration is absent from the release on disk, naming it and the
`ALTER TABLE` that undoes it if it is one of the two exceptions. "Could not
prove" is also a refusal, on the same statuses the rollback path treats as drift:

| Status | Means |
|---|---|
| `no-release` / `no-migrations-on-disk` | the release has no migrations to compare against |
| `no-client` | no usable `@prisma/client`: pruned, never generated, or generated for another platform |
| `no-url` | `DIRECT_DATABASE_URL` empty — absent, or continued onto a second line |
| `no-migrations-table` | no `_prisma_migrations` at all. Accepted **only** when Prisma independently reports every migration in the release as pending, which is a database at revision zero and a first deploy |
| `no-migrations-applied` | the table exists and records nothing applied: a dump restored without its rows, or a hand baseline. Nothing is known about that schema |
| `unfinished-migration` | a row with `finished_at IS NULL` and no `rolled_back_at` — Prisma's own definition of **failed**. It cannot appear in the applied list, so without this the set difference comes back empty and reports a clean bill over a half-applied schema |
| `probe-failed` | the query did not run |

The only way past a genuine refusal is to reconcile: roll forward with a fix, or
undo the schema change by hand and bring the release's migration directory with
it.

If a migration genuinely has to be undone, restore from backup and read the
duplicate-delivery warning in
[08-backup-restore-and-upgrades.md](../../apps/docs/self-hosting/08-backup-restore-and-upgrades.md):
deliveries that had already succeeded before the backup point are re-attempted,
and consumers see them again.

## Disk: `keep_releases = 3`

A release is a full checkout plus everything built from it. On a home server
that is the one resource worth counting:

| Per release | Roughly |
|---|---|
| `node_modules` across the workspace | **hardlinks**, not copies — pnpm's content-addressable store in `~deploy/.local/share/pnpm/store` holds one copy of each file version |
| Prisma client + query engines | 20–40 MB of real bytes, regenerated per release |
| `apps/control-api/dist` | a few MB |
| `apps/dashboard/dist` (with sourcemaps, `sourcemap: true` in the Vite config) | 5–15 MB |
| `bin/webhookd` | 20–40 MB |
| source checkout | a few MB; `update_code_strategy` is `archive`, so no `.git` |

Call it 150–250 MB of unique bytes per release, plus the shared pnpm store
(roughly 1–2 GB, once) and the Go build cache. Three releases is **under a
gigabyte** of real disk and buys you: the live one, one to roll back to, and one
spare for when the rollback target turns out to be the broken one too.

Raising it mostly costs store entries you cannot reclaim while a release
references them. Lowering it to 2 leaves exactly one rollback target; lowering it
to 1 means `dep rollback` has nothing to roll back to, which
`hookubit:config:validate` refuses.

`pnpm store prune` on the deploy user reclaims what no surviving release needs —
safe to run after a deploy, never during one.

## Deviations from the guide

Noted here so the docs can be fixed in a commit of their own:

1. **§7's systemd units point at fixed paths** (`/opt/hookubit/src`,
   `/opt/hookubit/bin/webhookd`). With those, the atomic swap and `dep rollback`
   change nothing — systemd keeps starting whatever is at the old path. Use the
   units in `systemd/`.
2. **§4 and §14 build as `hookubit` in `/opt/hookubit/src`**; here a separate
   `deploy` user writes releases and the service user only reads them.
3. **§5 sets the env file 0600**; the migration step needs it `0640
   root:hookubit`.
4. **§8 serves the dashboard from `/opt/hookubit/web` via rsync**; point nginx at
   `current/apps/dashboard/dist` and drop the copy.
5. **§6 and §14 read the env file with `env $(grep -v '^#' … | xargs -d '\n')`**,
   which breaks on `MAIL_FROM=HookuBit <no-reply@example.com>` — an unquoted `<`
   is a redirection. The recipe extracts only the two URLs Prisma needs, and
   strips quotes, `\r` and trailing blanks the way systemd does.
6. **§14's upgrade order migrates before restarting the API but after the build**,
   with no health check and no record of what was pending. The task graph here is
   the same procedure with the migration bracketed by the data-plane stop, the
   pending list printed, and a health check that fails loudly.
