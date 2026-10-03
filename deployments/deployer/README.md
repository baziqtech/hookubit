# Deploying HookuBit to a bare-metal Ubuntu server

This is [apps/docs/self-hosting/09-bare-metal-ubuntu.md](../../apps/docs/self-hosting/09-bare-metal-ubuntu.md),
automated. The guide is still the explanation; this is the procedure that runs.

```
make deploy                  # the whole thing
dep list                     # every task
dep hookubit:health          # just the probes, read-only
dep hookubit:dashboard:check # just "is the hostname serving this release", read-only
dep rollback                 # READ "Rollback" below first
```

Deployer is PHP, but nothing PHP runs on the server and the server needs neither
PHP nor Composer. It is here for three things a shell script does not give us:
a release directory per deploy, an atomic `current` symlink swap, and a rollback
that is one command.

**This deploys the whole platform: the control API, the data plane and the
dashboard.** The dashboard is built into the release and nginx serves it off that
release, so one `make deploy` ships all three and the `current` symlink swaps
them together. There is no second deploy path and no state in which the front
end and the API are from different commits. "I deployed and my UI change is not
there" is answered by `hookubit:dashboard:check`, which the deploy runs for you.

## Files

| Path | What it is |
|---|---|
| `../../deploy.php` | Entry point. `dep` finds it in the repo root. |
| `hookubit.php` | All tasks. Short on purpose; the reasoning lives here. |
| `hosts.yml` | **The only file you edit.** Hostname, user, deploy path, ports, and the dashboard's two build values. |
| `systemd/*.service` | The two units, pointing at `current/`. |
| `sudoers.d/hookubit-deploy` | The six privileged commands a deploy needs. |

The recipe assumes five things on the host, all installed by §3 of the guide:
`pnpm`, `go`, `systemctl`, `curl` — and **`psql`**, which the migration guard
uses to read `_prisma_migrations`. Without `postgresql-client` the guard refuses
the deploy rather than guessing, and says so.

It also needs **two values in `hosts.yml` that did not used to be there**, and
refuses at the very start of `hookubit:build` without them, before anything is
built, stopped or swapped:

| Key | Example | What it is |
|---|---|---|
| `dashboard_origin` | `https://hookubit.com` | the public origin nginx answers the dashboard **and** `/v1` on. Must equal `DASHBOARD_URL` in `shared/apps/control-api/.env` |
| `ingest_base_url` | `https://hooks.hookubit.com` | ingest's own hostname, compiled into the bundle as `VITE_INGEST_BASE_URL` |

Both are checked in `hookubit:build` even though only the first is *used* after
the swap, because that is the one place a refusal is free. Failing at
`hookubit:dashboard:check` over a missing line in `hosts.yml` would mean a red
deploy over a release that is already live and probably fine.

If you keep your `hosts.yml` out of commits with `git update-index
--skip-worktree`, add both keys by hand — the first deploy after this change
will otherwise refuse, naming the key and the line to add.

## One-time server setup

Follow §1–§5 and §7–§12 of the guide — database, Redis, toolchain, env file,
systemd, nginx and its firewall, Cloudflare, first account. Three things differ
from the guide, because the guide builds in one tree as one user and this does
not.

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
sudo chmod 2755 /opt/hookubit                # setgid: releases stay group-hookubit;
                                             # world r-x: nginx traverses in. See below.
```

Put your public key in `/home/deploy/.ssh/authorized_keys`, and a read-only
GitHub deploy key in `/home/deploy/.ssh/` — the server clones the repository, not
your laptop.

**`2755`, because there are now three readers, not two.** `deploy` owns the tree
and writes the releases; `hookubit` reads them as the group and runs them; and
**`www-data` reads them as *other***, because nginx serves
`current/apps/dashboard/dist` straight off the release (guide §8). The
world-execute bit is the search bit nginx needs to traverse in, and the
world-read bit on the files is what lets it open them.

That is wider than `2750`, and it is the price of one deploy instead of two.
What is in the tree is `bin/webhookd`, the control API's `dist`, a full
`node_modules` and the dashboard bundle — code, no secrets. The secrets are in
`shared/`, and they stay closed independently of this:

```bash
sudo chmod 0750 /opt/hookubit/shared
sudo chmod 0750 /opt/hookubit/shared/apps /opt/hookubit/shared/apps/control-api \
                /opt/hookubit/shared/services /opt/hookubit/shared/services/data-plane
```

Do that explicitly rather than relying on `/opt/hookubit`'s mode, which is the
whole point: widening the top of the tree then cannot widen anything that
matters.

::: danger Do not put `www-data` in the `hookubit` group
It looks like the tidier answer and it is strictly the worse one. The three env
files are `0640` with group `hookubit` (next section), so group membership hands
the **web server** `ENCRYPTION_KEY`, the database password, `JWT_SECRET` and
`SESSION_SECRET`. A web server is the process on this box most likely to be the
one that gets exploited, and it has no business being able to read any of them.
One world-execute bit on a directory of compiled code is a far smaller grant
than membership of the group that owns the secrets.
:::

**The umask corollary changed with the mode, and it is stricter than before.**
It used to be enough for the deploy user's umask to leave *group* read on,
because only `hookubit` read the tree. nginx reads it as **other** now:

| deploy user's umask | Release dirs/files | `hookubit` can run it | nginx can serve the bundle |
|---|---|---|---|
| `022` | `0755` / `0644` | yes | **yes** |
| `027` | `0750` / `0640` | yes | **no — `403` on every asset** |
| `077` | `0700` / `0600` | no | no |

`022` is Ubuntu's default and is what this recipe assumes. A `027` in
`/home/deploy/.profile` used to be fine and now produces a dashboard that `403`s
while the API, both units, `hookubit:health` and every localhost probe are green
— and it shows up one deploy *after* the change, because the live release still
has the old modes. `hookubit:dashboard:check` catches it on the deploy that
introduces it.

If you would rather keep the release tree closed to the world, an ACL is the
precise alternative — `setfacl -m u:www-data:rx` on `/opt/hookubit` and
`releases/`, plus a **default** ACL on `releases/` so new release directories
inherit it, and leave the path at `2750`. It is tighter and it is one more
mechanism to remember when you are debugging a `403`. The guide's §8 has both
forms; everything else here assumes `2755`.

**2. Configuration is three files under `shared/`, and the deploy seeds them.**

`/etc/hookubit/hookubit.env` is gone. The live files are:

| File | Holds | Read by |
|---|---|---|
| `shared/.env` | the **nine** variables both planes read — `APP_ENV`, `DATABASE_URL`, `LOG_LEVEL`, `REDIS_URL`, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_RETIRED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAMESPACE` | both units |
| `shared/apps/control-api/.env` | the control plane's own — `JWT_SECRET`, `SESSION_SECRET`, `TRUST_PROXY_HOPS`, `DASHBOARD_URL`, `SMTP_URL`, `MAIL_FROM`, `DIRECT_DATABASE_URL`, … | `hookubit-api` only |
| `shared/services/data-plane/.env` | the data plane's own — `S3_*`, `WORKER_*`, `ROUTER_*`, `EGRESS_*`, `BREAKER_*`, `INGEST_*`, `RETENTION_*`, … | `hookubit-data-plane` only |

The nine live in **one** file precisely so they cannot drift. Two copies of
`ENCRYPTION_KEY` that disagree means the control API encrypts endpoint signing
secrets the worker cannot decrypt: both processes validate their own
configuration happily and outbound signing breaks in silence. `DATABASE_URL` is
the same class of fault — ingest writes events the router never reads.

They are `shared_files`, so every release gets a symlink and
`hookubit:env` copies each **missing** one from its `.env.example` **on the first
deploy only**. You do not create them by hand. The first deploy will then refuse
at `hookubit:migrate`, because the templates ship every required variable present
and **empty** — that refusal names `DIRECT_DATABASE_URL` and says which file it
goes in. Fill all three in and re-run.

Edit them in place with your own editor; **no `sudo`**, because nothing in the
platform's configuration is a root-owned file any more. The modes the deploy
seeds, and why each half is needed:

```bash
# what hookubit:env creates — you should not have to run this
install -m 0640 -g hookubit <template> /opt/hookubit/shared/.env
```

- **Owner, the deploy user, read-write.** `prisma migrate deploy` and the
  migration guard run as that user over ssh and need `DATABASE_URL` (common file)
  and `DIRECT_DATABASE_URL` (control-api file).
- **Group `hookubit`, read.** This is the part that is easy to talk yourself out
  of, because systemd reads an `EnvironmentFile=` as **root** in PID 1 before it
  drops privileges — so the service user does not need it *for that*. It needs it
  for something else: `@nestjs/config` does `existsSync()` and then
  `readFileSync()` on `<release>/.env` and `<release>/apps/control-api/.env`,
  which are symlinks to these files, and an `EACCES` there is a control API that
  **does not boot at all**. Drop the group bit and you get a crash loop whose
  message is about a file permission, not about configuration.
- **Nothing for *other*.** `/opt/hookubit` is `2750` so nobody else can traverse
  in anyway, but these files hold `ENCRYPTION_KEY` and a database password and
  should not depend on a directory mode two levels up.

What went away with `/etc/hookubit`: a root-owned file, `sudo` to edit
configuration, and `chown root:hookubit` as a separate manual step. What did
**not** go away is the deploy user's membership of the `hookubit` group — the
seeding uses `install -g hookubit`, which a non-root user can only do as a member
of that group.

The trade is unchanged: the deploy user can read every secret, `ENCRYPTION_KEY`
included. That is the price of not granting it a broad `sudo -u hookubit`, which
would be strictly worse — an attacker with the deploy key could then run anything
as the service user. The deploy user is a trusted identity; treat its SSH key
like the env files themselves.

One thing the split **improves**: each unit now loads only its own file plus the
common one, so the control API is no longer handed `S3_SECRET_KEY` and the data
plane is no longer handed `JWT_SECRET` and `SESSION_SECRET`. The Kubernetes
manifests have been asserting that property in CI for a while; bare metal has it
now too.

### How the recipe reads them

`hb_env KEY` searches the two files the **control plane** reads, in precedence
order, and the **first file that defines the key wins** — even if it defines it
empty:

```
/opt/hookubit/shared/apps/control-api/.env     service-specific, searched first
/opt/hookubit/shared/.env                      common
```

That order is not a preference, it is the only one that matches both real
parsers. `@nestjs/config` walks `envFilePath` doing
`Object.assign(dotenv.parse(file), config)`, so **earlier** entries win and
`['.env', '../../.env']` means service-specific beats common. systemd arrives at
the same answer from the other end, because a **later** `EnvironmentFile=` wins
and the units list the common file first. A reader that resolved it differently
from the processes would be worse than no reader at all — in particular,
`DIRECT_DATABASE_URL=` present-and-empty in the service file **shadows** a value
in the common file, for all three.

`shared/services/data-plane/.env` is deliberately not in that list. No Node
process reads it, and a third source with no defined precedence against the other
two is how the migration ends up pointed at a different database than the
services.

It reads keys with `sed` and **never sources a file**. It cannot:
`MAIL_FROM=HookuBit <no-reply@example.com>` is valid for systemd's
`EnvironmentFile` and a redirection to `/bin/sh`. Reading it the way systemd does
takes three more steps a bare `sed -n 's|^KEY=||p'` skips, each of which would
otherwise hand Prisma a connection string that cannot connect: surrounding
quotes (valid, and systemd strips them), a trailing `\r` from a CRLF file, and
trailing blanks. `hb_env` strips all three and takes the **last** definition of a
repeated key within a file, which is also systemd's rule — so appending a
corrected line to the end of a seeded template works, and leaves the empty one
above it harmlessly.

**Each value must be on one physical line.** systemd joins a value whose line
ends in a backslash with the next line; `hb_env` reads one line, and a connection
string cut at the backslash usually still parses — so the services and the
migration would quietly use *different* databases. Rather than differ in silence,
`hb_env` refuses such a value, and so does the migration guard. It also refuses a
file that exists but cannot be read, rather than falling through to the next one,
for exactly the same reason.

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
file write. Be precise about what keeping it out buys, because it is **not** "a
stolen deploy key cannot redefine what runs" — it can. The deploy user owns the
release tree and the `current` symlink, so it can write any binary to
`current/bin/webhookd` and `sudo systemctl restart` straight into it. What the
exclusion actually buys:

- **No path to root.** A writable unit file is arbitrary code as root on the next
  start. Without it the blast radius stays inside the two service users.
- **The user and the hardening are fixed.** `User=`, `Group=`,
  `NoNewPrivileges=`, `ProtectSystem=`, `ReadWritePaths=` and the rest are
  root-owned and out of reach, so whatever the deploy user manages to run still
  runs as `hookubit`, confined, and not as root.

**The units must point at `current/` for code and at `shared/` for
configuration.** The guide's §7 units reference fixed code paths; with those, the
atomic swap and `dep rollback` change nothing, because systemd keeps starting
whatever is at the old path. The env files go the other way: they are read from
`shared/` directly, **not** through `current/`, so a restart does not depend on
which release is live or on the symlink swap having finished. Each unit carries
two `EnvironmentFile=` lines, **common first**, and neither is `-`-prefixed —
there is no state in which running without one of them is correct, and without
the dash systemd fails before `ExecStart` with the missing path in the message.
Use the units in `systemd/`. Nothing in the recipe checks this for you any
more — it is a one-time install step, and `systemctl cat hookubit-api` is how you
confirm it.

## What a deploy does, in order

`dep deploy --plan` prints this; it is Deployer's stock `deploy` with three
tasks hooked in.

1. `deploy:info`, `deploy:setup`, `deploy:lock`, `deploy:release`,
   `deploy:update_code` — a new release directory, code from the **pushed** ref.
2. **`hookubit:build`** — validates `dashboard_origin` and `ingest_base_url`,
   then `pnpm install --frozen-lockfile`, `pnpm generate` (installing alone does
   not produce the Prisma client), the control API, **the dashboard**, and the Go
   binary into `<release>/bin/webhookd`. It asserts every output exists, because
   a release with no `dist/main.js` or no `webhookd` is the one failure that
   reaches the restart and looks like something else.

   The dashboard is built with `VITE_API_TRANSPORT=http` (hardcoded in the
   recipe — `mock` ships a convincing product backed by an in-memory fixture, so
   a deploy must not be able to select it by typo) and
   `VITE_INGEST_BASE_URL={{ingest_base_url}}`. A plain `VAR=value` prefix is
   correct here because Deployer runs the command as the deploy user over ssh
   with no `sudo` in it; the guide's `sudo -u hookubit` form needs
   `sudo -u hookubit env VAR=value …`, because `env_reset` discards a prefix set
   on `sudo` itself.

   Then it **greps the built JS**: the configured ingest origin must be in it and
   `http://localhost:8080` must not, and no `.map` may exist. The greps read
   grep's status as three cases rather than two — `0` found, `1` not found,
   anything else the check did not run — because a filter written after a `--`
   becomes a filename, makes grep exit `2`, and would otherwise pass the negative
   assertion while searching nothing.

   **`hookubit:build` runs before `deploy:shared`, so no env file exists in the
   release yet, and the dashboard build needs none.** Both its variables come
   from the command line, and vite's `envDir` is `apps/dashboard/`, which has no
   `.env` in it and is not one of the three `shared_files`. Nothing in the bundle
   can be affected by the server's configuration — which is also why changing
   configuration cannot fix a bundle, only a rebuild can.
3. `deploy:env` — a **no-op**. The stock task copies one `dotenv_example` to one
   `.env`, and there are three files in three directories; it is replaced by an
   empty body rather than left pointed at a filename that does not exist.
   **`hookubit:env`** — hooked `before('deploy:shared')` — copies each *missing*
   `shared/<path>` from the release's `<path>.example`, `0640 <deploy>:hookubit`,
   and refuses the deploy if a template is absent from the release.
   `deploy:shared` then symlinks all three into the release
   (`<release>/.env`, `<release>/apps/control-api/.env`,
   `<release>/services/data-plane/.env`); its own "copy only when shared lacks
   the file" is the backstop that makes "first deploy only" true. `deploy:writable`
   is a no-op.
4. **`hookubit:migrate`** — compares what the database has applied against what
   this release carries, refuses on any mismatch (below), and when migrations are
   pending stops `hookubit-data-plane` **before** applying them. With nothing
   pending it stops nothing, so an ordinary code-only deploy has no delivery
   pause at all.
5. `deploy:symlink` — the atomic swap.
6. **`hookubit:restart`** — restarts both units, then `hookubit:health`:
   `/health/live` on the control API and `/health/ready` on the data plane's
   `:9090`, every two seconds for a minute. Then
   **`hookubit:dashboard:check`** (below). A failure in either fails the deploy,
   and says that the release is nevertheless live.
7. `deploy:unlock`, `deploy:cleanup`, `deploy:success`.

Two things this recipe deliberately no longer does, both of which it used to:

- **It does not check your `hosts.yml` before connecting.** A `REPLACE_ME`
  hostname now fails at the SSH connection instead of in a validator. Cheaper to
  read the error than to maintain the validator.
- **It does not compare your local tree against the remote ref.** Deployer
  deploys a **pushed** ref: if you have not pushed, you have not deployed, and
  nothing warns you. `git push` first, and `dep deploy --plan` shows you which
  ref is configured.

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
column name. It costs a short pause in ingest and delivery, which on a home
server is the right trade — the queue is PostgreSQL, so an unclaimed delivery is
a delivery still waiting.

One thing the recipe will not do for you: on a **large** `deliveries` table the
`next_attempt_at` migration wants the hand-run recipe in its own header (one
transaction per step, `lock_timeout = '5s'`, `CREATE INDEX CONCURRENTLY`),
because Prisma wraps the whole file in a single transaction and the
lock-avoiding idiom degrades to a full-table scan under an exclusive lock. Run
those steps by hand first; the migration then finds its work done.

### The one guard: what `hookubit:migrate` refuses, and why

It asks `psql` two questions — is there a `_prisma_migrations` table, and what
does it contain — lists the release's own `prisma/migrations` directories, and
compares the two sets. It never reads Prisma's prose, because **Prisma cannot
answer the question that matters.**

| Refusal | Means |
|---|---|
| the database is **AHEAD** of this release | an applied migration is not in this release's `prisma/migrations` |
| a migration never finished and was not rolled back | `finished_at IS NULL` with no `rolled_back_at` — Prisma's own definition of **failed**. It is absent from the applied list, so without this the comparison would come back clean over a half-applied schema |
| `DIRECT_DATABASE_URL` is defined in none of the env files | the usual first-deploy refusal: `shared/apps/control-api/.env` is still the unedited template. The message says which file and shows the line |
| `DIRECT_DATABASE_URL` is defined, with an empty value | the line is there with nothing after the `=`. Check the control-api file first: an empty value there **shadows** the common file |
| `DIRECT_DATABASE_URL` is continued onto a second line with a backslash | systemd would join the lines; `hb_env` will not guess |
| an env file exists but could not be read | the mode or the group was changed. The refusal prints the `chmod`/`chgrp` and says why the service user needs the group bit too |
| the release has no `prisma/migrations` | nothing to compare against |
| the query did not run | no `psql`, an unreachable database, a wrong password. The message carries what `psql` said, with anything URL-shaped redacted, because that string holds the password |

Everything except the first is a *could not prove*, and all of them refuse. That
is the whole design: the guard will not print an all-clear it has not earned.
**Each refusal now carries only advice that is true of it** — the `psql` failure
no longer comes back with three paragraphs about the router not draining and a
`SELECT` against a table the guard could not reach. All of them end with the one
line that *is* true of all five: nothing was stopped and nothing was swapped,
because the guard runs before the data-plane stop.
A database with **no `_prisma_migrations` table at all** is the one case that
proceeds — nothing is applied, so nothing can be ahead, and that is a first
deploy.

A fresh table with zero rows against a populated schema is **allowed** past the
guard, and then `prisma migrate deploy` refuses it loudly (`CREATE TABLE` on an
existing table), before the symlink moves. Loud failures do not need a guard.

### Deploying an older ref

`dep deploy --tag v1.3.0` is the documented way to put an older release back
after a bad one — so it is a **recovery path**, not an unlikely accident, and it
is the reason the guard exists at all.

The release's `prisma/migrations` is then a strict *prefix* of what is applied,
which Prisma 5.22 classifies `migrationsDirectoryIsBehind` — a diagnostic
`migrate status` has **no handler for**. It falls through to
`Database schema is up to date!` and exits 0. So without a direct comparison the
deploy goes fully green: no migrations pending, symlink swapped, the **old**
router started, and **both health probes 200**, because readiness opens a pg pool
and never runs the router's claim query. The router then cannot parse
`fan_out_cursor`, ingest keeps answering `202`, and nothing is delivered.

The only way past that refusal is to reconcile. Roll forward with a fix, which is
almost always the answer. If the older release genuinely has to go live, undo the
schema change by hand first and bring its migration directory with it:

```sql
ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;
ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;
```

If a migration genuinely has to be undone, restore from backup and read the
duplicate-delivery warning in
[08-backup-restore-and-upgrades.md](../../apps/docs/self-hosting/08-backup-restore-and-upgrades.md):
deliveries that had already succeeded before the backup point are re-attempted,
and consumers see them again.

## `hookubit:dashboard:check`

It takes the hashed entry module out of the release's own
`apps/dashboard/dist/index.html` — `/assets/index-<hash>.js` — and requires that
exact filename in what the dashboard hostname serves. Then it asserts that
`/v1/auth/session` comes back as `application/json` and not as HTML.

It is read-only, it runs after `hookubit:health`, and you can run it on its own
at any time.

**Why it is back.** It was dropped while the dashboard was hosted elsewhere,
when all it could have done is restate someone else's deployment log. nginx
serves the bundle off the release now, and that brings back one failure that
nothing else on the deploy path can see: **an nginx `root` that does not go
through `current`**. Point it at `releases/7/apps/dashboard/dist`, or at an
`/opt/hookubit/src` left over from a hand-built install, and every deploy
afterwards succeeds completely — build, migrate, swap, both probes `200` — while
the hostname keeps serving the bundle from whenever that path was last right.
The old JS talks to the new API over `/v1` and mostly works, which is exactly
what lets it survive unnoticed. Comparing one hash is the cheapest thing that
notices.

**It probes nginx on loopback, not the public name.** `curl --resolve` sends the
right `Host` and SNI to `127.0.0.1`, with `-k`, because the origin certificate is
a Cloudflare Origin CA cert that is not meant to be publicly trusted. Through
real DNS the same request would also depend on Cloudflare's cache, Cloudflare's
health and the guide's packet filter — none of which a deploy changed, and any of
which could fail a release that is perfectly good. **A deploy must not go red
because an edge cached an `index.html`.** The public path is a per-install check,
by hand, in §9 of the guide.

The three things it actually catches, and what each refusal says:

| Refusal | Cause |
|---|---|
| `/v1` answered `text/html` | the `location ^~ /v1/` block is missing, or is written without `^~` and a regex location out-ranked it. Every screen in the dashboard is broken; this is the worst of the three and it is named first |
| served HTML does not reference this release's entry module | nginx's `root` — almost always. Not the edge: this probe never left loopback |
| nginx did not answer on loopback | the server block is in `sites-available` and not symlinked, or nginx is not running |

What it cannot catch: whether the *public* hostname is reachable, and whether
Cloudflare is serving a stale `index.html`. Both are §9 of the guide, and both
are install-time rather than per-deploy.

## Health, and what a failure means

`hookubit:health` polls both probes every two seconds for a minute, and prints
`live=<code> ready=<code>`. If it fails after the swap, the release **is** live:
the symlink moved and any pending migrations were applied, so going back is a
schema decision rather than a symlink one. The recipe does not roll back for
you, deliberately.

`curl -s localhost:9090/health/ready` is the next thing to read, because it
distinguishes two PostgreSQL stories that look identical from a dashboard:

| Body | Means |
|---|---|
| `"postgres":"connecting"` | The pool has **never** been opened. `DATABASE_URL`, `pg_hba.conf`, or the firewall. Not a blip. |
| `"postgres":"down"` | A pool was opened and **lost**. The database host or the network went away; the data plane retries on a backoff rather than exiting. |
| `"status":"starting"` | The probe port is bound but readiness never flipped — it has not reached the database yet. |
| `"status":"draining"` | It is shutting down. Look for a crash loop. |

Where a failure leaves you depends on where it happened, and the task that was
running tells you:

- **In `hookubit:build`** — nothing was stopped, nothing was swapped, the live
  release is untouched. The half-built release is left for inspection and
  `deploy:cleanup` will remove it on the next successful deploy.
- **In `hookubit:migrate`, at the guard** — likewise. The guard runs before the
  data-plane stop, so a refusal costs nothing.
- **In `hookubit:migrate`, during `prisma migrate deploy`** — the data plane is
  **down** and the schema may have moved part-way. Nothing is being delivered,
  and ingest is answering `502` through nginx because ingest is part of the data
  plane. Fix the cause and re-run `make deploy`: `prisma migrate deploy` is
  idempotent, and a re-run restarts both units for you. Do not start the data
  plane by hand onto the *old* release if migrations were applied.
- **After the swap** — the new release is live and unhealthy.
  `journalctl -u hookubit-api -u hookubit-data-plane -n 100` and the readiness
  body above. Rolling forward is usually faster than rolling back.
- **In `hookubit:dashboard:check`** — the new release is live and the API is the
  new one; only the bundle in front of it is in question. Nothing about it is
  release-specific, so it will keep failing the same way on the next deploy
  until nginx is fixed. It is the last task that can fail, deliberately: it is
  the least urgent of the three failures and the one most likely to be a
  one-time server misconfiguration rather than a bad release.

## Rollback

> **`dep rollback` swaps the symlink. The database does not roll back.**
> This platform ships no down-migrations, by design.

So a rollback across a schema change runs **old code against a new schema**.
Across `20260923000000_rename_fan_out_to_routing` that specifically means the
router stops draining the outbox **silently**: the old binary looks for
`fan_out_cursor`, the column is `routing_cursor`, ingest keeps answering `202`,
and nothing is delivered. Undo it by hand **first**:

```sql
ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;
ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;
```

`hookubit:rollback:warn` prints that and asks before anything moves; `no` leaves
the platform exactly as it was. Afterwards `hookubit:restart` brings both units
onto the rolled-back release and health-checks — without it the symlink points at
the old release while the processes keep running the new code, which is worse
than no rollback because it reports success.

**The rollback does not check the schema for you.** The deploy's guard is the
only drift check in this recipe, by choice: one guard, on the path you take a
hundred times, rather than two to keep in step. Before you answer `yes`, look:

```sql
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY 1;
```

and compare it with `ls releases/<n>/apps/control-api/prisma/migrations`.

**Rolling forward is almost always better.** Rollback is for "the new code is
broken and the schema did not move".

## Disk: `keep_releases = 3`

A release is a full checkout plus everything built from it. On a home server that
is the one resource worth counting:

| Per release | Roughly |
|---|---|
| `node_modules` across the workspace | **hardlinks**, not copies — pnpm's content-addressable store in `~deploy/.local/share/pnpm/store` holds one copy of each file version |
| Prisma client + query engines | 20–40 MB of real bytes, regenerated per release |
| `apps/control-api/dist` | a few MB |
| `bin/webhookd` | 20–40 MB |
| source checkout | a few MB; `update_code_strategy` is `archive`, so no `.git` |

| `apps/dashboard/dist` | ~1 MB of real bytes — 12 files, and no sourcemap, because `vite.config.ts` sets `build.sourcemap: false`. With one it would be ~4 MB |

Call it 150–250 MB of unique bytes per release, plus the shared pnpm store
(roughly 1–2 GB, once) and the Go build cache. Three releases is **under a
gigabyte** of real disk and buys you the live one, one to roll back to, and one
spare for when the rollback target turns out to be broken too. Lowering it to 1
means `dep rollback` has nothing to roll back to.

`pnpm store prune` on the deploy user reclaims what no surviving release needs —
safe to run after a deploy, never during one.

## Deviations from the guide

The guide and this recipe now describe the same server. What is left is the
difference between doing it by hand once and doing it on every push:

1. **§7's systemd units point at fixed paths** (`/opt/hookubit/src`,
   `/opt/hookubit/bin/webhookd`). With those, the atomic swap and `dep rollback`
   change nothing — systemd keeps starting whatever is at the old path. Use the
   units in `systemd/`.
2. **§4 and §14 build as `hookubit` in `/opt/hookubit/src`**; here a separate
   `deploy` user writes releases and the service user only reads them.
3. **§5 and this page now describe the same three files in the same place** —
   `shared/.env`, `shared/apps/control-api/.env`,
   `shared/services/data-plane/.env`. The guide writes them by hand because it
   has no deploy; here `hookubit:env` seeds them from the templates on the first
   deploy and you fill them in. The guide's old `0600 hookubit:hookubit` is what
   made a deploy fail — the deploy user could not read it — so the mode is
   `0640` with group `hookubit` in both places.
4. **§3 creates `/opt/hookubit/{src,bin}`** for a single-tree build. Here the
   deploy owns `releases/`, `shared/` and `current`, and neither `src` nor a
   top-level `bin` is used. nginx's `root` differs with it: §8's
   `/opt/hookubit/current/apps/dashboard/dist` is the recipe's path, and a
   single-tree install serves `/opt/hookubit/src/apps/dashboard/dist` instead.
5. **§14 upgrades in place, in one tree.** Same order as here — build, migrate
   with the data plane stopped, restart, probe — but with no release directory,
   so there is nothing to roll back to and nothing to compare the applied
   migrations against. The guide says so; this is the mechanised version of it.
