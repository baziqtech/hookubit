# Deploying HookuBit to a bare-metal Ubuntu server

This is [apps/docs/self-hosting/09-bare-metal-ubuntu.md](../../apps/docs/self-hosting/09-bare-metal-ubuntu.md),
automated. The guide is still the explanation; this is the procedure that runs.

```
make deploy             # the whole thing
dep list                # every task
dep hookubit:health     # just the probes, read-only
dep rollback            # READ "Rollback" below first
```

Deployer is PHP, but nothing PHP runs on the server and the server needs neither
PHP nor Composer. It is here for three things a shell script does not give us:
a release directory per deploy, an atomic `current` symlink swap, and a rollback
that is one command.

**This deploys the server side only: the control API and the data plane.** The
dashboard is static files that Cloudflare's git integration builds and publishes
on every push — a different trigger, a different timeline, and nothing here
touches it. Its build settings live in `apps/dashboard/README.md` in the
repository. "I deployed and my UI change is not there" is answered in
Cloudflare's deployment log, not here.

## Files

| Path | What it is |
|---|---|
| `../../deploy.php` | Entry point. `dep` finds it in the repo root. |
| `hookubit.php` | All tasks. Short on purpose; the reasoning lives here. |
| `hosts.yml` | **The only file you edit.** Hostname, user, deploy path, ports. |
| `systemd/*.service` | The two units, pointing at `current/`. |
| `sudoers.d/hookubit-deploy` | The six privileged commands a deploy needs. |

The recipe assumes four things on the host, all installed by §3 of the guide:
`pnpm`, `go`, `systemctl` — and **`psql`**, which the migration guard uses to
read `_prisma_migrations`. Without `postgresql-client` the guard refuses the
deploy rather than guessing, and says so.

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
sudo chmod 2750 /opt/hookubit                # setgid: releases stay group-hookubit
```

Put your public key in `/home/deploy/.ssh/authorized_keys`, and a read-only
GitHub deploy key in `/home/deploy/.ssh/` — the server clones the repository, not
your laptop.

**`2750`, and nothing for *other*.** Two users need to read this tree and both
are named in the mode: `deploy` owns it and writes the releases, `hookubit` reads
them as the group and runs them. Nobody else has any business in there — it holds
`bin/webhookd`, the control API's `dist`, and a full `node_modules`.

If this server was set up when nginx served the dashboard off this disk, it is
probably `2755`, because `www-data` needed a search bit to traverse into
`current/apps/dashboard/dist`. **nginx serves no files here any more**, so that
grant now buys nothing and widens the tree to every account on the box.
Retighten it with the `chmod` above; nothing in the deploy or in either unit
depends on the world bits, so it is safe while the platform is running.

Do not put `www-data` in the `hookubit` group either. `/etc/hookubit/hookubit.env`
is `0640 root:hookubit` (next section), so that would hand the web server
`ENCRYPTION_KEY`, the database password and every other secret on the box — and
there is no longer any question it was the answer to.

One umask corollary survives: `hookubit` reads the release **as the group**, so
the deploy user's umask must leave group-read on. Ubuntu's `022` does, `027`
does, `077` in `/home/deploy/.profile` does not — and the symptom is a service
user that cannot read the code it is supposed to run.

**2. The env file is group-readable.** `prisma migrate deploy` and the migration
guard run as the deploy user and need `DATABASE_URL` and `DIRECT_DATABASE_URL`:

```bash
sudo chown root:hookubit /etc/hookubit/hookubit.env
sudo chmod 0640 /etc/hookubit/hookubit.env
```

The trade: the deploy user can read every secret in that file, `ENCRYPTION_KEY`
included. That is the price of not granting it a broad `sudo -u hookubit`, which
would be strictly worse — an attacker with the deploy key could then run anything
as the service user. The deploy user is a trusted identity; treat its SSH key
like the env file itself.

The recipe reads only those two keys, with `sed`, and never sources the file. It
cannot: `MAIL_FROM=HookuBit <no-reply@example.com>` is valid for systemd's
`EnvironmentFile` and a redirection to `/bin/sh`. Reading it the way systemd does
takes three more steps a bare `sed -n 's|^KEY=||p'` skips, each of which would
otherwise hand Prisma a connection string that cannot connect: surrounding
quotes (valid, and systemd strips them), a trailing `\r` from a CRLF file, and
trailing blanks. `hb_env` strips all three and takes the **last** definition of a
repeated key, which is also systemd's rule.

**Each value must be on one physical line.** systemd joins a value whose line
ends in a backslash with the next line; `hb_env` reads one line, and a connection
string cut at the backslash usually still parses — so the services and the
migration would quietly use *different* databases. Rather than differ in silence,
`hb_env` refuses such a value, and the empty result makes the migration guard
refuse the deploy.

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

**The units must point at `current/`.** The guide's §7 units reference fixed
paths; with those, the atomic swap and `dep rollback` change nothing, because
systemd keeps starting whatever is at the old path. Use the ones in `systemd/`.
Nothing in the recipe checks this for you any more — it is a one-time install
step, and `systemctl cat hookubit-api` is how you confirm it.

## What a deploy does, in order

`dep deploy --plan` prints this; it is Deployer's stock `deploy` with three
tasks hooked in.

1. `deploy:info`, `deploy:setup`, `deploy:lock`, `deploy:release`,
   `deploy:update_code` — a new release directory, code from the **pushed** ref.
2. **`hookubit:build`** — `pnpm install --frozen-lockfile`, `pnpm generate`
   (installing alone does not produce the Prisma client), the control API, and
   the Go binary into `<release>/bin/webhookd`. It asserts both outputs exist,
   because a release with no `dist/main.js` or no `webhookd` is the one failure
   that reaches the restart and looks like something else. **No dashboard**:
   Cloudflare builds that, and building it here would produce a bundle nobody
   serves.
3. `deploy:env`, `deploy:shared`, `deploy:writable` — no-ops here. `dotenv_example`
   is deliberately pointed at a file that does not exist, so `deploy:env` copies
   nothing: otherwise this repo's 12 KB `.env.example` would land as `.env` in
   every release, and the control API reads `../../.env`. Configuration lives in
   the env file systemd loads.
4. **`hookubit:migrate`** — compares what the database has applied against what
   this release carries, refuses on any mismatch (below), and when migrations are
   pending stops `hookubit-data-plane` **before** applying them. With nothing
   pending it stops nothing, so an ordinary code-only deploy has no delivery
   pause at all.
5. `deploy:symlink` — the atomic swap.
6. **`hookubit:restart`** — restarts both units, then `hookubit:health`:
   `/health/live` on the control API and `/health/ready` on the data plane's
   `:9090`, every two seconds for a minute. A failure here fails the deploy, and
   says that the release is nevertheless live.
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
| `DIRECT_DATABASE_URL` came back empty | absent from the env file, or continued onto a second line with a backslash |
| the release has no `prisma/migrations` | nothing to compare against |
| the query did not run | no `psql`, an unreachable database, a wrong password. The message carries what `psql` said, with anything URL-shaped redacted, because that string holds the password |

Everything except the first is a *could not prove*, and all of them refuse. That
is the whole design: the guard will not print an all-clear it has not earned.
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

No `apps/dashboard/dist` row: it is not built here, which took 5–15 MB of
sourcemapped bundle off every release.

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
3. **§5 sets the env file `0600`**; the migration step needs it `0640
   root:hookubit`.
4. **§3 creates `/opt/hookubit/{src,bin}`** for a single-tree build. Here the
   deploy owns `releases/`, `shared/` and `current`, and neither `src` nor a
   top-level `bin` is used.
5. **§14 upgrades in place, in one tree.** Same order as here — build, migrate
   with the data plane stopped, restart, probe — but with no release directory,
   so there is nothing to roll back to and nothing to compare the applied
   migrations against. The guide says so; this is the mechanised version of it.
