<?php

/**
 * HookuBit — bare-metal Ubuntu deploy tasks.
 *
 * This is apps/docs/self-hosting/09-bare-metal-ubuntu.md, automated, with the
 * upgrade ordering from apps/docs/self-hosting/08-backup-restore-and-upgrades.md
 * encoded in the task graph rather than left to whoever is awake.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, AND WHY THE NAIVE ONE IS WRONG
 * ---------------------------------------------------------------------------
 *
 * The default rule for this platform is "migrate ahead of the code": migrations
 * are written so the old binaries keep working against the new schema for the
 * length of a rollout. Two migrations in the history break that rule, and both
 * say so in capitals in their own header:
 *
 *   20260911000000_next_attempt_at_not_null
 *       The data plane carrying the fix must be live everywhere BEFORE the
 *       constraint is applied. Apply it first and every terminal transition
 *       still in flight from an older worker fails its UPDATE, the attempt row
 *       rolls back with it, and the delivery sits in `processing` until its
 *       lease expires — then gets retried against an endpoint that has ALREADY
 *       received it.
 *
 *   20260923000000_rename_fan_out_to_routing
 *       A single RENAME COLUMN on event_outbox. There is no window in which
 *       both names exist, so the old router's claim query fails at parse time
 *       and the router stops draining the outbox ENTIRELY. Ingest does not name
 *       the column, so the platform keeps answering 202 Accepted the whole
 *       time: publishers see success, nothing is delivered, and the backlog is
 *       invisible on the events page.
 *
 * Neither failure is loud. So this recipe runs the migration with the data
 * plane STOPPED, which is the conservative order that satisfies both:
 *
 *   - no older worker is alive to have its UPDATE rejected, so the
 *     next_attempt_at exception's "confirm no older worker is still running"
 *     is satisfied by construction (we did not merely upgrade it first — we
 *     took it out of the picture);
 *   - no old router is alive to parse `fan_out_cursor`, and the binary that
 *     starts afterwards is the new one, so the rename's window is zero.
 *
 * It costs a short ingest-and-deliver pause. On a home server that is the right
 * trade: the queue is PostgreSQL, so an unclaimed delivery is a delivery still
 * waiting, and the alternative is a two-phase deploy whose middle state is a
 * silent stall.
 *
 * The full graph:
 *
 *   1. hookubit:preflight         local only — config + git staleness guard
 *   2. deploy:info/setup/lock/    new release, code from the PUSHED ref
 *      release/update_code/
 *      shared/writable
 *   3. hookubit:toolchain         node/go/pnpm/env-file on the host
 *      hookubit:systemd:check     units exist AND point at current/
 *   4. hookubit:build:*           install, generate, api, data-plane, dashboard
 *   5. hookubit:migrate:status    PRINTS pending migrations, names exceptions,
 *                                 and COMPARES _prisma_migrations against the
 *                                 release's own migration directories — see
 *                                 below
 *   6. hookubit:data-plane:stop
 *   7. hookubit:migrate:deploy    from the NEW release
 *   8. deploy:symlink             the atomic swap
 *   9. hookubit:api:restart
 *  10. hookubit:data-plane:start
 *  11. hookubit:health            /health/live + /health/ready, fails loudly
 *      hookubit:dashboard:check  nginx really serves THIS release's bundle
 *  12. deploy:unlock, cleanup, success
 *
 * ---------------------------------------------------------------------------
 * ROLLBACK — READ THIS BEFORE YOU RUN `dep rollback`
 * ---------------------------------------------------------------------------
 *
 * `dep rollback` swaps the symlink. THE DATABASE DOES NOT ROLL BACK. This
 * platform ships no down-migrations, by design.
 *
 * So a rollback across a schema change leaves OLD CODE against a NEW SCHEMA,
 * and across 20260923000000_rename_fan_out_to_routing that means precisely the
 * silent stall described above: the old router looks for `fan_out_cursor`, the
 * column is now `routing_cursor`, every claim fails at parse time, ingest keeps
 * answering 202, and nothing is delivered. Across
 * 20260911000000_next_attempt_at_not_null you must drop the constraint by hand
 * first:
 *
 *     ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;
 *
 * `hookubit:rollback:before` asks Prisma whether the database is ahead of the
 * release you are rolling back to and refuses without an explicit yes. Rolling
 * FORWARD with a fix is almost always the better move. If a migration genuinely
 * has to be undone, restore from backup and read the duplicate-delivery warning
 * in apps/docs/self-hosting/08-backup-restore-and-upgrades.md.
 *
 * `hookubit:rollback:failed` is registered with fail('rollback', ...) and reports
 * the half-state if the run dies between the data-plane stop and the restart:
 * which release current/ actually points at, and whether the data plane is up.
 * It starts the data plane again when the code that is live is the code this
 * schema matches, and refuses to — in capitals — when it is not.
 *
 * ---------------------------------------------------------------------------
 * AND THE SAME TRAP WHEN DEPLOYING AN OLDER REF
 * ---------------------------------------------------------------------------
 *
 * `dep deploy --tag v1.3.0` is the documented way to put an older release back
 * after a bad one, so it is the RECOVERY path. The release's prisma/migrations
 * is then a strict PREFIX of what is applied, which Prisma 5.22 classifies
 * migrationsDirectoryIsBehind — a diagnostic `migrate status` has NO handler
 * for. It falls through to "Database schema is up to date!" and exit 0.
 *
 * So `prisma migrate status` cannot be the only question asked.
 * hookubit:migrate:status compares the applied set against the release's own
 * migration directories and refuses when the database is ahead, because
 * everything downstream of it would otherwise go green: no migrations pending,
 * symlink swapped, old router started, BOTH health probes 200 — readiness opens
 * a pg pool, it never runs the router's claim query — while nothing at all is
 * delivered.
 */

namespace Deployer;

add('recipes', ['hookubit']);

// ---------------------------------------------------------------------------
// The two migrations that invert the ordering rule.
// ---------------------------------------------------------------------------

if (!defined('HOOKUBIT_EXCEPTION_MIGRATIONS')) {
    define('HOOKUBIT_EXCEPTION_MIGRATIONS', [
        '20260911000000_next_attempt_at_not_null' =>
            'requires NO OLD WORKER ALIVE when the constraint is applied; applying it ' .
            'under an older data plane fails terminal UPDATEs and re-delivers to endpoints ' .
            'that already received the event',
        '20260923000000_rename_fan_out_to_routing' =>
            'renames event_outbox.fan_out_cursor to routing_cursor with NO overlap window; ' .
            'an old router stops draining the outbox silently while ingest keeps answering 202',
    ]);
}

// ---------------------------------------------------------------------------
// Defaults. Host-specific values belong in hosts.yml, never here.
// ---------------------------------------------------------------------------

// Three releases. See deployments/deployer/README.md for the disk arithmetic:
// pnpm hardlinks node_modules out of a shared store, so the real per-release
// cost is the Prisma client + engines, the Go binary and the two dist/ trees —
// roughly 150-250 MB each, not the apparent size of node_modules.
set('keep_releases', 3);

// pnpm install plus five builds. The 300s default is not close to enough.
set('default_timeout', 1800);

// `archive` keeps .git out of every release. We never run git in a release.
set('update_code_strategy', 'archive');

// Nothing is shared between releases on the filesystem. The one piece of state
// that must survive a deploy is the env file, and it lives in /etc — see
// `env_file` below and the README for why that rather than shared/.
set('shared_dirs', []);
set('shared_files', []);
set('writable_dirs', []);

set('env_file', '/etc/hookubit/hookubit.env');

// Must agree with CONTROL_API_PORT and DATA_PLANE_METRICS_PORT in the env file.
set('control_api_port', 3000);
set('data_plane_metrics_port', 9090);

// Compiled into the dashboard bundle and unchangeable afterwards. Without
// `http` the dashboard silently runs its in-memory mock: every screen works,
// against data that does not exist.
set('vite_api_transport', 'http');

// The toolchain CI builds with. go.mod states a MINIMUM, not a pin.
set('go_version', '1.27');
set('node_min_major', 20);

set('health_attempts', 30);
set('health_interval', 2);

set('bin/node', '/usr/bin/node');
set('bin/pnpm', '/usr/bin/pnpm');
set('bin/go', '/usr/local/go/bin/go');

// Privileged: start/stop/restart only, through the sudoers file in
// deployments/deployer/sudoers.d/hookubit-deploy. An operator who would rather
// deploy as root sets this to '/usr/bin/systemctl' in hosts.yml.
set('bin/systemctl', 'sudo /usr/bin/systemctl');

// Unprivileged, read-only: is-active, status. Never add sudo here.
set('bin/systemctl_query', '/usr/bin/systemctl');

set('api_unit', 'hookubit-api');
set('data_plane_unit', 'hookubit-data-plane');
set('systemd_dir', '/etc/systemd/system');

// Where `prisma migrate status` and the toolchain check run from. During a
// deploy `release_or_current_path` is the new release; outside one it is the
// live release, which is what makes `dep hookubit:verify` work unchanged.
set('migrate_path', '{{release_or_current_path}}');
set('check_path', '{{release_or_current_path}}');

// The repository root on the operator's machine, for the staleness guard.
set('local_repo', dirname(__DIR__, 2));

// Escape hatches, all off. `dep deploy -o allow_stale_ref=true`.
set('allow_stale_ref', false);
set('migration_exceptions_ack', false);

// hookubit:dashboard:check fetches the dashboard over its PUBLIC hostname,
// which the server itself has to be able to resolve and reach — split-horizon
// DNS, a Cloudflare-only record or an outbound firewall all break that without
// anything being wrong with the deploy. Hence the skip, and hence the override
// for an internal URL that reaches the same nginx vhost.
set('skip_dashboard_check', false);
set('dashboard_check_url', '');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

if (!function_exists('Deployer\\hb_flag')) {
    /**
     * `-o key=true` arrives as the string "true". Treat the usual words as yes
     * and everything else, including "false" and "0", as no.
     */
    function hb_flag(string $key): bool
    {
        $value = has($key) ? get($key) : false;
        if (is_bool($value)) {
            return $value;
        }
        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true);
    }
}

if (!function_exists('Deployer\\hb_raw')) {
    /**
     * Writes text WITHOUT running it through Deployer's {{...}} interpolation.
     *
     * Everything that reaches writeln() is parsed, and a commit subject, a
     * journal line or a filename containing `{{anything}}` would then raise a
     * ConfigurationException about an unknown config key — turning a clear
     * failure report into a confusing one. Untrusted text goes through here.
     */
    function hb_raw(string $text): void
    {
        output()->writeln($text);
    }
}

if (!function_exists('Deployer\\hb_required')) {
    /**
     * A required host value: present, non-empty, and not still a placeholder.
     */
    function hb_required(string $key, string $what): string
    {
        $value = has($key) ? trim((string) get($key)) : '';
        if ($value === '') {
            throw error("Missing `$key` in deployments/deployer/hosts.yml — $what.");
        }
        if (str_contains($value, 'REPLACE_ME')) {
            throw error("`$key` in deployments/deployer/hosts.yml is still a placeholder — $what.");
        }
        return $value;
    }
}

if (!function_exists('Deployer\\hb_env_sh')) {
    /**
     * A shell prelude defining `hb_env KEY`, which reads one key out of the
     * systemd EnvironmentFile the way systemd itself reads it.
     *
     * Why not source the file, and why not the guide's
     * `env $(grep -v '^#' file | xargs)`: `MAIL_FROM=HookuBit <no-reply@example.com>`
     * is valid for `EnvironmentFile` and a redirection to /bin/sh. So we anchor
     * on `^KEY=` and take the LAST definition, which is also systemd's rule when
     * a key appears twice.
     *
     * And then three things plain `sed` gets wrong where systemd does not. Each
     * one hands Prisma a connection string that cannot connect, which before the
     * exit-code handling in hookubit:migrate:status read back as "no pending
     * migrations":
     *
     *   · Surrounding quotes. `DATABASE_URL="postgresql://..."` is valid, and
     *     systemd strips the quotes; sed does not, so the quote travels into the
     *     connection string.
     *   · CRLF. An env file edited on Windows leaves a trailing \r on every value.
     *   · Trailing blanks, which survive the match.
     *
     * The one place it deliberately does NOT follow systemd: a value whose line
     * ends in a backslash. systemd joins it with the next line; this reads ONE
     * physical line, and a connection string truncated at a `\` usually still
     * parses, so the migration would run against a different database than the
     * services do. Rather than differ in silence, hb_env REFUSES such a value --
     * it writes to stderr and returns non-zero, so the value arrives empty and
     * every caller's empty-value guard fires. hookubit:toolchain checks the file
     * up front, where the message can name the key.
     */
    function hb_env_sh(): string
    {
        return str_replace(
            '__HB_ENV_FILE__',
            escapeshellarg(parse('{{env_file}}')),
            <<<'SH'
            HB_ENV_FILE=__HB_ENV_FILE__
            hb_env() {
              hb_env_value=$(sed -n "s|^$1=||p" "$HB_ENV_FILE" \
                | tail -n1 \
                | tr -d '\r' \
                | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
              case "$hb_env_value" in
                *\\)
                  echo "hb_env: $1 in $HB_ENV_FILE ends in a backslash. systemd joins that with the next line; this reads one physical line only, so the services and this deploy would use different values. Put the value on a single line." >&2
                  return 65
                  ;;
              esac
              printf '%s\n' "$hb_env_value"
            }
            SH,
        );
    }
}

if (!function_exists('Deployer\\hb_migration_drift')) {
    /**
     * Is the database ahead of $releasePath?
     *
     * By DIRECT COMPARISON, not by reading Prisma's prose. Two reasons the
     * prose cannot answer this:
     *
     *   · The phrases do not exist. Prisma 5.22's bundled CLI contains no
     *     "applied to the database but missing from the local migrations
     *     directory", no "not found in the local migrations directory" and no
     *     "database schema is not in sync". The only thing it says in that
     *     neighbourhood is "not found locally in prisma/migrations", and only
     *     on the historiesDiverge path.
     *   · The case that matters does not print anything at all. When the local
     *     prisma/migrations is a strict PREFIX of what is applied — which is
     *     exactly a rollback — the diagnostic is migrationsDirectoryIsBehind,
     *     which `migrate status` does not handle: it falls through to
     *     "Database schema is up to date!" and exit 0.
     *
     * So: list the applied migrations out of _prisma_migrations, list the
     * migration directories in the release, and diff them. The query goes
     * through the release's own @prisma/client (resolved from the release, so a
     * pruned or half-built release reports a failed probe rather than a clean
     * bill) and uses DIRECT_DATABASE_URL, because a pooler is the wrong place
     * to ask.
     *
     * Returns ['status' => ..., 'applied' => [...], 'disk' => [...],
     * 'unfinished' => [...], 'rolled_back' => [...], 'detail' => [...]].
     * Status is 'ok' only when the comparison was actually made against a
     * history that says something. EVERY other status means "could not prove
     * the database is not ahead", and the caller must read that as drift:
     *
     *   no-release             the release has no prisma/migrations directory
     *   no-url                 DIRECT_DATABASE_URL came back empty
     *   no-client              @prisma/client did not resolve, or would not construct
     *   probe-failed           the query did not run
     *   no-migrations-table    there is no _prisma_migrations table at all
     *   no-migrations-on-disk  the release's prisma/migrations is empty
     *   no-migrations-applied  _prisma_migrations records nothing applied, so
     *                          nothing whatever is known about this schema
     *   unfinished-migration   a row with finished_at IS NULL and no
     *                          rolled_back_at: Prisma's own definition of a
     *                          FAILED migration. It cannot appear in the
     *                          applied list, so without this the set
     *                          difference comes back empty and reports a clean
     *                          bill over a half-applied schema
     */
    function hb_migration_drift(string $releasePath): array
    {
        $probe = str_replace(
            '__HB_REL__',
            escapeshellarg($releasePath),
            <<<'SH'
            HB_REL=__HB_REL__
            HB_API="$HB_REL/apps/control-api"
            if [ ! -d "$HB_API/prisma/migrations" ]; then
              echo 'HB_RESULT=no-release'
              exit 0
            fi
            for d in "$HB_API"/prisma/migrations/*/; do
              [ -f "$d/migration.sql" ] || continue
              n=${d%/}
              printf 'HB_DISK %s\n' "${n##*/}"
            done
            DATABASE_URL="$(hb_env DATABASE_URL)"
            DIRECT_DATABASE_URL="$(hb_env DIRECT_DATABASE_URL)"
            if [ -z "$DIRECT_DATABASE_URL" ]; then
              echo 'HB_RESULT=no-url'
              exit 0
            fi
            export DATABASE_URL DIRECT_DATABASE_URL
            HB_TMP="$(mktemp -d)" || { echo 'HB_RESULT=probe-failed'; exit 0; }
            cat > "$HB_TMP/drift.cjs" <<'HB_JS'
            const apiDir = process.env.HB_API_DIR;
            // Prisma's initialisation errors quote the datasource URL, and that
            // URL carries the database password. Everything printed from here
            // reaches the operator's terminal and any CI log, so every message
            // goes through redact() first.
            const redact = (v) =>
              String((v && v.message) || v).replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]*/g, '<url redacted>');
            let prisma;
            try {
              const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [apiDir] }));
              // The constructor belongs INSIDE the try. run() hands back stdout
              // only and no_throw swallows the exception that stderr rides on,
              // so a constructor throw -- a client generated for another
              // platform, a missing query engine -- would be discarded and read
              // back as the far vaguer "the query did not run".
              prisma = new PrismaClient({
                datasources: { db: { url: process.env.DIRECT_DATABASE_URL } },
              });
            } catch (err) {
              console.log('HB_DETAIL ' + redact(err).split('\n')[0]);
              console.log('HB_RESULT=no-client');
              process.exit(0);
            }
            prisma
              // to_regclass returns NULL instead of raising for a name that does
              // not exist, so this distinguishes "no history table" from "the
              // query failed". A pristine database has no table, and that is not
              // the same unknown as a table with nothing in it.
              .$queryRawUnsafe("SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present")
              .then((probe) => {
                if (!probe || !probe[0] || probe[0].present !== true) {
                  console.log('HB_RESULT=no-migrations-table');
                  return;
                }
                return prisma
                  .$queryRawUnsafe(
                    'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name',
                  )
                  .then((rows) => {
                    for (const row of rows) {
                      // finished_at wins: a row Prisma finished counts as
                      // applied even if someone also marked it rolled back, and
                      // counting it applied is the side that errs towards
                      // REPORTING drift. `!= null` also catches undefined, so a
                      // column that did not come back lands on 'unfinished'.
                      const state =
                        row.finished_at != null
                          ? 'applied'
                          : row.rolled_back_at != null
                            ? 'rolledback'
                            : 'unfinished';
                      console.log('HB_ROW ' + state + ' ' + row.migration_name);
                    }
                    console.log('HB_RESULT=ok');
                  });
              })
              .catch((err) => {
                console.log('HB_DETAIL ' + redact(err).split('\n').join(' / '));
                console.log('HB_RESULT=probe-failed');
              })
              .finally(() => prisma.$disconnect());
            HB_JS
            HB_API_DIR="$HB_API" {{bin/node}} "$HB_TMP/drift.cjs" || echo 'HB_RESULT=probe-failed'
            rm -rf "$HB_TMP"
            SH,
        );

        $raw = (string) run("set -u\n" . hb_env_sh() . "\n" . $probe, no_throw: true);

        $status = 'probe-failed';
        $disk = [];
        $applied = [];
        $unfinished = [];
        $rolledBack = [];
        $detail = [];
        foreach (preg_split('/\R/', $raw) as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'HB_DISK ')) {
                $disk[] = substr($line, 8);
            } elseif (str_starts_with($line, 'HB_ROW ')) {
                $parts = explode(' ', substr($line, 7), 2);
                if (count($parts) !== 2 || trim($parts[1]) === '') {
                    // Unparseable row: show it and leave the status alone, so
                    // the 'ok' path below cannot be reached on a guess.
                    $detail[] = $line;
                    $unfinished[] = '(unparseable row)';
                } elseif ($parts[0] === 'applied') {
                    $applied[] = $parts[1];
                } elseif ($parts[0] === 'rolledback') {
                    $rolledBack[] = $parts[1];
                } else {
                    $unfinished[] = $parts[1];
                }
            } elseif (str_starts_with($line, 'HB_DETAIL ')) {
                $detail[] = substr($line, 10);
            } elseif (str_starts_with($line, 'HB_RESULT=')) {
                $status = substr($line, 10);
            } elseif ($line !== '') {
                $detail[] = $line;
            }
        }

        // An 'ok' with nothing on disk is not an answer: every applied
        // migration would read as drift for the wrong reason.
        if ($status === 'ok' && $disk === []) {
            $status = 'no-migrations-on-disk';
        }

        // A row with finished_at IS NULL and no rolled_back_at is Prisma's own
        // definition of a FAILED migration, and it cannot appear in $applied --
        // so the set difference below would come back empty and this function
        // would hand back 'ok' over a half-applied schema. Fail-OPEN, in the one
        // function whose 'ok' is supposed to mean "the comparison was made".
        // It matters most for 20260911000000_next_attempt_at_not_null, whose
        // header prescribes CREATE INDEX CONCURRENTLY: that cannot run inside a
        // transaction, so a failure part-way through leaves DDL behind that this
        // probe would otherwise report as not applied at all.
        if ($status === 'ok' && $unfinished !== []) {
            $status = 'unfinished-migration';
        }

        // And an 'ok' with nothing APPLIED proves nothing either: a dump
        // restored without _prisma_migrations' rows, or a hand baseline, leaves
        // an empty history against a populated schema. That is the same "not
        // managed by Prisma Migrate" condition hookubit:migrate:status already
        // refuses -- not a clean bill over zero rows.
        if ($status === 'ok' && $applied === []) {
            $status = 'no-migrations-applied';
        }

        return [
            'status' => $status,
            'applied' => $applied,
            'disk' => $disk,
            'unfinished' => $unfinished,
            'rolled_back' => $rolledBack,
            'detail' => $detail,
        ];
    }
}

if (!function_exists('Deployer\\hb_stage')) {
    function hb_stage(string $stage): void
    {
        set('hookubit_stage', $stage);
    }
}

if (!function_exists('Deployer\\hb_reached')) {
    /**
     * Has the deploy got at least as far as $stage? Used by the failure handler
     * to decide what is safe to touch.
     */
    function hb_reached(string $stage): bool
    {
        $order = [
            'init', 'locked', 'checked', 'built', 'surveyed',
            'data-plane-stopped', 'migrated', 'symlinked', 'api-restarted',
            'data-plane-started', 'healthy',
        ];
        $current = has('hookubit_stage') ? (string) get('hookubit_stage') : '';
        $a = array_search($current, $order, true);
        $b = array_search($stage, $order, true);
        return $a !== false && $b !== false && $a >= $b;
    }
}

// ---------------------------------------------------------------------------
// 1. Preflight — runs entirely on the operator's machine. No SSH.
// ---------------------------------------------------------------------------

desc('Validates host configuration (local only, no connection)');
task('hookubit:config:validate', function () {
    hb_stage('init');

    $hostname = currentHost()->getHostname() ?? '';
    if ($hostname === '' || str_contains($hostname, 'REPLACE_ME')) {
        throw error(
            "The host's `hostname` in deployments/deployer/hosts.yml is still a placeholder.\n" .
            "Fill in the home server's address (or an SSH config alias) before deploying.",
        );
    }

    hb_required('remote_user', 'the SSH user that owns releases/ on the server');
    hb_required('deploy_path', 'where releases/, shared/ and current live, e.g. /opt/hookubit');
    hb_required('repository', 'the git URL the SERVER clones from; a pushed ref is what gets deployed');
    $domain = hb_required('app_domain', 'the hostname the dashboard and control API are served from');
    $ingest = hb_required(
        'ingest_base_url',
        'compiled into the dashboard bundle as VITE_INGEST_BASE_URL and unchangeable afterwards',
    );

    // VITE_API_TRANSPORT is the difference between a working dashboard and one
    // that silently runs its in-memory mock. Never let it default.
    $transport = hb_required('vite_api_transport', "must be `http`, or the dashboard builds against its mock");
    if ($transport !== 'http') {
        throw error(
            "vite_api_transport is `$transport`, not `http`.\n" .
            "Any other value builds a dashboard that runs its in-memory mock: every screen\n" .
            "works, backed by data that does not exist. Refusing to build that bundle.",
        );
    }

    if (!str_starts_with($ingest, 'https://')) {
        throw error("ingest_base_url must be an https:// origin, got `$ingest`. Publishers sign request bodies; do not carry them over plain HTTP.");
    }
    if (str_ends_with($ingest, '/')) {
        throw error("ingest_base_url must not end with a slash, got `$ingest`. It is concatenated into the get-started example.");
    }
    if (preg_match('~^https://(localhost|127\.0\.0\.1|\[::1\])~i', $ingest)) {
        throw error("ingest_base_url is `$ingest`. That is baked into the bundle and tells every operator to publish to their own laptop.");
    }
    // Ingest has its own hostname, so compare the parent domain rather than the
    // dashboard's: webhooks.example.com and hooks.example.com are the guide's
    // own pairing. A mismatch here is usually a half-replaced example value.
    $parent = implode('.', array_slice(explode('.', $domain), 1));
    $ingestHost = (string) parse_url($ingest, PHP_URL_HOST);
    if ($parent !== '' && $ingestHost !== '' && !str_ends_with($ingestHost, $parent)) {
        warning("ingest_base_url ($ingestHost) is not under the same parent domain as app_domain ($domain). Deliberate, or a leftover example value?");
    }
    if ($ingest === "https://$domain") {
        warning("ingest_base_url is the same origin as the dashboard. The guide gives ingest its own hostname: different traffic shape, no cookies, limited and scaled separately.");
    }

    $keep = (int) get('keep_releases');
    if ($keep < 2) {
        throw error("keep_releases is $keep. At least 2 — `dep rollback` needs a release to roll back to.");
    }

    info("host           {$hostname} as " . get('remote_user'));
    info("deploy_path    " . get('deploy_path'));
    info("repository     " . get('repository'));
    info("dashboard      https://{$domain}");
    info("ingest         {$ingest}  (compiled into the bundle)");
    info("env file       " . get('env_file') . "  (shared across releases, not in the release tree)");
    info("keep_releases  {$keep}");
});

desc('Refuses to deploy stale code: a ref behind your tree, or commits never pushed');
task('hookubit:guard:ref', function () {
    // Deployer deploys a PUSHED git ref, so a dirty working tree is not the
    // risk here — it simply is not deployed. The risks are (a) the ref on the
    // remote is behind what you have locally, so you deploy yesterday's fix,
    // and (b) you have commits that were never pushed at all.
    $root = (string) get('local_repo');
    $repo = (string) get('repository');
    $target = (string) get('target');
    $git = 'git -C ' . escapeshellarg($root);
    $env = ['GIT_TERMINAL_PROMPT' => '0'];
    $ack = hb_flag('allow_stale_ref');

    try {
        runLocally("$git rev-parse --git-dir", env: $env);
    } catch (\Throwable) {
        warning("No git repository at $root — cannot compare local and remote. Skipping the staleness guard.");
        return;
    }

    if (preg_match('/^[0-9a-f]{40}$/i', $target)) {
        if (!$ack) {
            throw error(
                "Deploying an explicit revision ($target) skips the staleness guard, because there is\n" .
                "no branch to compare against. Re-run with -o allow_stale_ref=true if that is deliberate.",
            );
        }
        warning("Deploying explicit revision $target with the staleness guard waived.");
        return;
    }

    // Resolve the branch and the tag SEPARATELY. Asking for both namespaces in
    // one `git ls-remote` and taking the first 40-hex line silently prefers the
    // branch, because git advertises refs/heads/ before refs/tags/ — so
    // `--tag v1.4.0` with a leftover branch of the same name would deploy the
    // BRANCH tip, which is the one invariant this guard exists to hold.
    $readRef = function (string ...$patterns) use ($git, $repo, $env, $target): string {
        $args = implode(' ', array_map(static fn (string $ref): string => escapeshellarg($ref), $patterns));
        try {
            return runLocally("$git ls-remote " . escapeshellarg($repo) . " $args", env: $env);
        } catch (\Throwable $e) {
            throw error(
                "Could not read `$target` from $repo.\n" .
                "The guard cannot tell whether you are about to deploy stale code, so it refuses.\n" .
                "Check your credentials for the remote, then retry.\n\n" . $e->getMessage(),
            );
        }
    };

    $branchSha = preg_match('/^([0-9a-f]{40})\s+refs\/heads\//m', $readRef("refs/heads/$target"), $m) ? $m[1] : null;

    // An annotated tag's ref points at the tag OBJECT; `refs/tags/X^{}` is the
    // commit it peels to, and that is what we want to deploy and to compare
    // ancestry against. A lightweight tag has no peeled line and its ref is
    // already the commit.
    $tagOut = $readRef("refs/tags/$target", "refs/tags/$target^{}");
    $tagSha = null;
    if (preg_match('/^([0-9a-f]{40})\s+refs\/tags\/\S+\^\{\}$/m', $tagOut, $m)) {
        $tagSha = $m[1];
    } elseif (preg_match('/^([0-9a-f]{40})\s+refs\/tags\//m', $tagOut, $m)) {
        $tagSha = $m[1];
    }

    if ($branchSha !== null && $tagSha !== null) {
        throw error(
            "`$target` exists on $repo as BOTH a branch and a tag:\n" .
            "  refs/heads/$target  $branchSha\n" .
            "  refs/tags/$target   $tagSha\n" .
            "Which one you meant is not guessable, and git advertises the branch first, so the\n" .
            "guard would have silently pinned the branch tip. Delete the one you do not want\n" .
            "(`git push origin :refs/heads/$target`), or deploy the commit explicitly with\n" .
            "`--revision <sha> -o allow_stale_ref=true`.",
        );
    }

    if ($branchSha === null && $tagSha === null) {
        throw error(
            "`$target` exists on $repo as neither a branch nor a tag.\n" .
            "Deployer deploys what the SERVER can clone. Push the branch or the tag (or pick\n" .
            "another with --branch / --tag) first.",
        );
    }

    $remote = $branchSha ?? $tagSha;
    if ($tagSha !== null) {
        info("`$target` resolved as a TAG: $remote");
    }

    $localRef = trim(runLocally("$git rev-parse --verify --quiet " . escapeshellarg("refs/heads/$target") . ' || true'));

    if ($localRef === '') {
        warning("No local branch `$target`; cannot compare. The remote's $remote is what will be deployed.");
    } elseif ($localRef === $remote) {
        info("ref `$target` is identical locally and on the remote: $remote");
    } else {
        $haveRemote = trim(runLocally("$git cat-file -e " . escapeshellarg($remote . '^{commit}') . ' 2>/dev/null && echo yes || echo no'));
        if ($haveRemote !== 'yes') {
            $message =
                "The remote `$target` is at $remote, which is not in your local object store.\n" .
                "You cannot know what you are about to deploy. Run `git fetch` and look first.";
            if (!$ack) {
                throw error($message . "\nOverride with -o allow_stale_ref=true.");
            }
            warning($message);
            set('target', $remote);
            return;
        }

        $remoteIsAncestor = trim(runLocally("$git merge-base --is-ancestor $remote $localRef && echo yes || echo no"));
        $localIsAncestor = trim(runLocally("$git merge-base --is-ancestor $localRef $remote && echo yes || echo no"));

        if ($remoteIsAncestor === 'yes') {
            $behind = trim(runLocally("$git log --oneline --no-decorate $remote..$localRef"));
            $count = $behind === '' ? 0 : count(explode("\n", $behind));
            writeln('Commits on your local branch that the remote does not have:');
            hb_raw($behind);
            $message =
                "STALE: the remote `$target` is $count commit(s) BEHIND your local branch.\n" .
                "Deploying would ship $remote and leave the unpushed work listed above on your machine.\n" .
                "Push first: git push origin $target";
            if (!$ack) {
                throw error($message . "\n\nOverride with -o allow_stale_ref=true.");
            }
            warning($message);
        } elseif ($localIsAncestor === 'yes') {
            warning(
                "The remote `$target` is AHEAD of your local branch. You would deploy $remote,\n" .
                "which contains commits you have not fetched and have not read.",
            );
            if (!$ack && !askConfirmation("Deploy the remote's $target anyway?", false)) {
                throw error('Aborted: fetch and review the remote commits first.');
            }
        } else {
            $message =
                "DIVERGED: local `$target` ($localRef) and remote `$target` ($remote) have no\n" .
                "ancestry between them. Reconcile them before deploying.";
            if (!$ack) {
                throw error($message . "\n\nOverride with -o allow_stale_ref=true.");
            }
            warning($message);
        }
    }

    // Is the work you are looking at even in the ref you are deploying?
    $head = trim(runLocally("$git rev-parse HEAD"));
    if ($head !== $remote) {
        $contained = trim(runLocally("$git merge-base --is-ancestor $head $remote && echo yes || echo no"));
        if ($contained !== 'yes') {
            warning("Your checked-out HEAD ($head) is not contained in `$target`. Nothing you have in hand is being deployed.");
        }
    }

    $dirty = trim(runLocally("$git status --porcelain"));
    if ($dirty !== '') {
        info('Uncommitted changes in your working tree will NOT be deployed (Deployer ships a pushed ref):');
        hb_raw($dirty);
    }

    // Pin the deploy to exactly the commit the guard approved, so the remote
    // moving between now and deploy:update_code cannot change what ships.
    set('target', $remote);
    set('hookubit_revision', $remote);
    info("deploying $remote");
});

desc('Local-only checks: configuration and git staleness. Connects to nothing');
task('hookubit:preflight', [
    'hookubit:config:validate',
    'hookubit:guard:ref',
]);

// ---------------------------------------------------------------------------
// 3. Host checks
// ---------------------------------------------------------------------------

desc('Checks the server toolchain, the env file and the two database URLs');
task('hookubit:toolchain', function () {
    $node = (string) get('bin/node');
    $pnpm = (string) get('bin/pnpm');
    $go = (string) get('bin/go');
    $envFile = (string) get('env_file');

    foreach (['bin/node' => $node, 'bin/pnpm' => $pnpm, 'bin/go' => $go] as $key => $bin) {
        if (!test("command -v " . escapeshellarg($bin) . " >/dev/null 2>&1")) {
            throw error("`$bin` not found on the host (configured as `$key`). See §3 of apps/docs/self-hosting/09-bare-metal-ubuntu.md.");
        }
    }

    $nodeVersion = trim(run(escapeshellarg($node) . ' --version'));
    if (preg_match('/^v(\d+)/', $nodeVersion, $m) && (int) $m[1] < (int) get('node_min_major')) {
        throw error("Node $nodeVersion on the host; this repo needs >= " . get('node_min_major') . ' (CI builds on 22).');
    }

    $pnpmVersion = trim(run('cd {{check_path}} && ' . escapeshellarg($pnpm) . ' --version'));
    $goVersion = trim(run(escapeshellarg($go) . ' version'));
    if (!str_contains($goVersion, 'go' . get('go_version'))) {
        warning("Host Go is `$goVersion`; CI builds with go" . get('go_version') . ". go.mod states a minimum, not a pin — the CI version is the one that has been tested.");
    }

    if (!test("[ -r " . escapeshellarg($envFile) . " ]")) {
        throw error(
            "$envFile is not readable as " . get('remote_user') . ".\n" .
            "The migration step needs DATABASE_URL and DIRECT_DATABASE_URL from it.\n" .
            "Make it root:hookubit mode 0640 and put the deploy user in the hookubit group\n" .
            "(see deployments/deployer/README.md, 'One-time server setup').",
        );
    }
    foreach (['DATABASE_URL', 'DIRECT_DATABASE_URL'] as $key) {
        if (!test("grep -q " . escapeshellarg("^$key=") . ' ' . escapeshellarg($envFile))) {
            throw error("$key is not set in $envFile. Prisma needs both URLs; with no pooler they are the same string.");
        }
    }

    // systemd joins a value whose line ends in a backslash with the next line.
    // hb_env reads ONE physical line (see its docblock), and a connection string
    // truncated at the backslash usually still parses -- so the migration would
    // run against a different database than the services, quietly. Refuse here,
    // where the message can name the key, rather than at the point of use where
    // all that is left is "the URL came back empty".
    //
    // Only the key is printed, never the value: these lines carry the database
    // password and this output goes to a terminal and into CI logs.
    $continued = trim((string) run(
        'grep -v ' . escapeshellarg('^[[:space:]]*#') . ' ' . escapeshellarg($envFile) .
        ' | grep ' . escapeshellarg('\\\\[[:space:]]*$') .
        ' | sed -e ' . escapeshellarg('s/=.*/=<value>/') . ' || true',
    ));
    if ($continued !== '') {
        hb_raw($continued);
        throw error(
            "The value(s) above in $envFile are continued onto a second line with a trailing\n" .
            "backslash. systemd's EnvironmentFile joins those lines; this recipe reads one\n" .
            "physical line, so the services and the migration would use DIFFERENT values -- and\n" .
            "a connection string cut at the backslash usually still parses, so the difference\n" .
            "would not announce itself. Put each value on a single line.",
        );
    }

    info("node $nodeVersion · pnpm $pnpmVersion · $goVersion");
});

desc('Checks the systemd units exist and actually point at current/');
task('hookubit:systemd:check', function () {
    $dir = (string) get('systemd_dir');
    $current = parse('{{current_path}}');
    $envFile = (string) get('env_file');

    foreach ([get('api_unit'), get('data_plane_unit')] as $unit) {
        $path = "$dir/$unit.service";
        if (!test("[ -f " . escapeshellarg($path) . " ]")) {
            throw error(
                "$path does not exist.\n" .
                "Install the units from deployments/deployer/systemd/ once, by hand, as root:\n" .
                "  sudo install -m 0644 -o root -g root <repo>/deployments/deployer/systemd/$unit.service $dir/\n" .
                "  sudo systemctl daemon-reload && sudo systemctl enable $unit\n" .
                "They are deliberately NOT installed by the deploy: writing to $dir is a root\n" .
                "file write, and the deploy user's sudo rights stop at start/stop/restart.",
            );
        }

        $body = run('cat ' . escapeshellarg($path));
        if (!str_contains($body, $current)) {
            throw error(
                "$path does not reference $current.\n" .
                "The units shipped in the guide's §7 run /opt/hookubit/src and\n" .
                "/opt/hookubit/bin/webhookd — fixed paths. With those units the atomic symlink\n" .
                "swap changes nothing: systemd keeps starting whatever is at the old path, and a\n" .
                "deploy appears to succeed while the old code runs.\n" .
                "Use deployments/deployer/systemd/$unit.service instead.",
            );
        }
        if (!str_contains($body, $envFile)) {
            warning("$path has no EnvironmentFile=$envFile. The service will start without its configuration.");
        }
    }

    hb_stage('checked');
    info('systemd units point at ' . $current);
});

desc('Checks the HTML nginx serves references an asset from THIS release');
task('hookubit:dashboard:check', function () {
    // The sibling of hookubit:systemd:check, for the half of the platform that
    // systemd does not start. The deploy's health probes go straight to
    // 127.0.0.1:{{control_api_port}} and :{{data_plane_metrics_port}} — never
    // through nginx — so nothing else here notices that nginx is serving a
    // different tree than the one just deployed. Two ways that happens, both of
    // them a green deploy:
    //
    //   · nginx was left on the guide's §8 `root /opt/hookubit/web`, which the
    //     release layout never writes to. The bundle never changes, for ever.
    //   · nginx can reach the release root but cannot traverse into it, so every
    //     visitor gets 403 while /v1/* keeps working because it is proxied.
    //
    // So: take an asset filename out of the release's own index.html and look
    // for it in what the public hostname actually returns.
    if (hb_flag('skip_dashboard_check')) {
        warning(
            'hookubit:dashboard:check SKIPPED (-o skip_dashboard_check=true). Nothing has verified ' .
            'that nginx serves this release; a 403 or a stale bundle will not fail this deploy.',
        );
        return;
    }

    $dist = parse('{{release_or_current_path}}/apps/dashboard/dist');
    if (!test('[ -f ' . escapeshellarg("$dist/index.html") . ' ]')) {
        throw error(
            "$dist/index.html does not exist on the host, so there is nothing to compare what\n" .
            "nginx serves against. During a deploy hookubit:build:dashboard would already have\n" .
            "failed; outside one, this release has no dashboard build.",
        );
    }
    $html = run('cat ' . escapeshellarg("$dist/index.html"));

    // WHICH asset is anchored on matters. Vite content-hashes per chunk, so a
    // stylesheet that did not change keeps its filename across releases — and a
    // check that accepted any ONE referenced asset would pass on a stale bundle
    // whose CSS happened to be identical while its JavaScript was a release
    // old. The entry module IS the application, so that is what has to match,
    // and every entry has to, not one of them.
    $assets = [];
    if (preg_match_all('~<script\b[^>]*>~i', $html, $tags)) {
        foreach ($tags[0] as $tag) {
            if (!preg_match('~\btype\s*=\s*["\x27]module["\x27]~i', $tag)) {
                continue;
            }
            if (preg_match('~\bsrc\s*=\s*["\x27]([^"\x27]*assets/[A-Za-z0-9][A-Za-z0-9._-]*\.js)["\x27]~i', $tag, $sm)) {
                $assets[] = ltrim($sm[1], '/');
            }
        }
    }
    $assets = array_values(array_unique($assets));

    if ($assets === []) {
        // No module entry to anchor on — a different bundler output, or the
        // file is not what we think. Fall back to every hashed asset the
        // document references, and still require all of them.
        preg_match_all('~assets/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css)~', $html, $m);
        $assets = array_values(array_unique($m[0]));
    }
    if ($assets === []) {
        throw error(
            "$dist/index.html references no hashed asset under assets/.\n" .
            "Either the build emitted something this check cannot read, or the file is not the\n" .
            "dashboard's index.html at all. Look before deciding.",
        );
    }

    $url = trim((string) get('dashboard_check_url'));
    if ($url === '') {
        $url = 'https://' . get('app_domain') . '/';
    }

    $script = str_replace('__HB_URL__', escapeshellarg($url), <<<'SH'
        set -u
        HB_TMP="$(mktemp)" || { echo 'HB_HTTP=000'; exit 0; }
        code="$(curl -sS -L --max-time 15 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
                 -o "$HB_TMP" -w '%{http_code}' __HB_URL__ 2>/dev/null)" || code=000
        [ -n "$code" ] || code=000
        echo "HB_HTTP=$code"
        echo 'HB_BODY_BEGIN'
        head -c 65536 "$HB_TMP"
        echo
        echo 'HB_BODY_END'
        rm -f "$HB_TMP"
        SH);

    $out = (string) run($script, timeout: 60, no_throw: true);
    if (!preg_match('/^HB_HTTP=(\d+)/m', $out, $m)) {
        hb_raw($out);
        throw error("The dashboard check did not run on the host — curl produced no status at all (output above).");
    }
    $code = $m[1];

    $body = '';
    $begin = strpos($out, "HB_BODY_BEGIN\n");
    $end = strrpos($out, 'HB_BODY_END');
    if ($begin !== false && $end !== false && $end > $begin) {
        $body = substr($out, $begin + 14, $end - ($begin + 14));
    }

    if ($code === '000') {
        throw error(
            "Nothing answered at $url from the server itself.\n" .
            "That is usually DNS or egress, not the deploy: the box may not resolve its own\n" .
            "public hostname, or cannot reach it from inside. Two ways out:\n" .
            "  · give the check a URL the box CAN reach that lands on the same nginx vhost —\n" .
            "    an internal name, not plain 127.0.0.1, which may answer from a different\n" .
            "    server block and so prove nothing:\n" .
            "      -o dashboard_check_url=https://hookubit.lan/\n" .
            "  · or skip it, and then look at the dashboard in a browser yourself:\n" .
            "      -o skip_dashboard_check=true\n" .
            "Add the flag to whichever command you ran — `dep deploy`, `dep hookubit:verify` or\n" .
            "`dep hookubit:dashboard:check`. They are ordinary config overrides, not deploy-only.",
        );
    }

    if ($code === '403') {
        // TWO causes, and this check cannot tell them apart from the status code
        // alone. The default URL is the PUBLIC hostname, which normally sits
        // behind Cloudflare, and a managed challenge or error 1020 answers curl
        // — no browser UA, no JavaScript — with exactly this 403. Prescribing
        // `chmod 2755` for that would be loosening permissions to fix something
        // that is not a permissions problem, so the WAF reading comes first.
        throw error(
            "$url returned 403, and that has two quite different causes.\n\n" .
            "1. A WAF OR CDN IN FRONT, not nginx at all. This URL is the public hostname, which\n" .
            "   normally sits behind Cloudflare: a managed challenge, a bot-fight rule or error\n" .
            "   1020 answers curl with 403 because curl sends no browser user-agent and runs no\n" .
            "   JavaScript. The dashboard is then fine in a browser. Point the check at a URL\n" .
            "   that reaches the same nginx vhost directly, bypassing the edge:\n" .
            "     -o dashboard_check_url=https://<internal-name>/\n" .
            "   An internal name, not plain 127.0.0.1, which may answer from a different server\n" .
            "   block and so prove nothing. Check the response body printed above — Cloudflare\n" .
            "   says so in its HTML, and a Cf-Ray or Server: cloudflare header settles it:\n" .
            "     curl -sSI " . escapeshellarg($url) . "\n\n" .
            "2. NGINX CANNOT TRAVERSE INTO THE RELEASE. Still the likelier cause on a FIRST\n" .
            "   deploy. nginx workers run as www-data, which is in neither `" . get('remote_user') . "`\n" .
            '   nor `hookubit`. Without the search bit for OTHER on ' . get('deploy_path') . " they\n" .
            "   cannot open index.html, and only the proxied /v1/* paths keep working — which is\n" .
            "   why the health check passed. Confirm it is really this before changing any mode:\n" .
            '     namei -l ' . parse('{{current_path}}') . "/apps/dashboard/dist/index.html\n" .
            "     sudo -u www-data cat " . escapeshellarg(parse('{{current_path}}') . '/apps/dashboard/dist/index.html') . " >/dev/null\n" .
            "   If that is the fault, fix the mode on the deploy root:\n" .
            '     sudo chmod 2755 ' . get('deploy_path') . "\n" .
            "   and check nothing in the release tree is group/other-unreadable (the deploy\n" .
            "   user's umask must leave world-read on: 022, not 027).\n" .
            "   See deployments/deployer/README.md, 'One-time server setup'.",
        );
    }

    if ($code !== '200') {
        throw error(
            "$url returned HTTP $code, so nothing here can confirm the new bundle is being\n" .
            "served. Check the nginx vhost and its error log before calling this deploy done.",
        );
    }

    $absent = [];
    foreach ($assets as $asset) {
        if (!str_contains($body, $asset)) {
            $absent[] = $asset;
        }
    }

    if ($absent !== []) {
        throw error(
            "$url answered 200, but its HTML does not reference what this release built:\n" .
            '  ' . implode("\n  ", $absent) . "\n\n" .
            "nginx is serving a DIFFERENT tree. The usual cause is the guide's §8 layout, still\n" .
            "in place: `root /opt/hookubit/web`, which nothing in a release deploy ever writes\n" .
            "to — so the bundle never changes and every deploy looks green. Point it at the\n" .
            "symlink instead:\n" .
            '  root ' . parse('{{current_path}}') . "/apps/dashboard/dist;\n" .
            "The other cause is a cache in front: index.html must be served `Cache-Control:\n" .
            "no-store` (guide §8) or browsers keep requesting asset names that no longer exist.",
        );
    }

    info("nginx at $url serves this release (" . implode(', ', $assets) . ')');
});

// ---------------------------------------------------------------------------
// 4. Build
// ---------------------------------------------------------------------------

desc('pnpm install --frozen-lockfile');
task('hookubit:build:install', function () {
    run('cd {{release_path}} && {{bin/pnpm}} install --frozen-lockfile', real_time_output: true);
});

desc('Generates the Prisma client (pnpm install alone does not produce it)');
task('hookubit:build:generate', function () {
    run('cd {{release_path}} && {{bin/pnpm}} generate', real_time_output: true);
});

desc('Builds the control API to apps/control-api/dist');
task('hookubit:build:api', function () {
    run('cd {{release_path}} && {{bin/pnpm}} --filter @hookubit/control-api build', real_time_output: true);
    if (!test('[ -f {{release_path}}/apps/control-api/dist/main.js ]')) {
        throw error('The control API build produced no apps/control-api/dist/main.js.');
    }
});

desc('Builds the data-plane binary to the release\'s bin/webhookd');
task('hookubit:build:data-plane', function () {
    // Into the release, not /opt/hookubit/bin — the binary is part of the
    // release so the symlink swap and the rollback carry it with the code.
    run('cd {{release_path}}/services/data-plane && {{bin/go}} build -o {{release_path}}/bin/webhookd ./cmd/webhookd', real_time_output: true);
    if (!test('[ -x {{release_path}}/bin/webhookd ]')) {
        throw error('go build produced no executable at {{release_path}}/bin/webhookd.');
    }
});

desc('Builds the dashboard with the two values that are compiled in');
task('hookubit:build:dashboard', function () {
    $ingest = (string) get('ingest_base_url');
    $transport = (string) get('vite_api_transport');

    // hookubit:config:validate has already refused to get here with either of
    // these empty, a transport other than `http`, or a localhost ingest URL.
    run(
        'cd {{release_path}} && VITE_API_TRANSPORT=' . escapeshellarg($transport)
        . ' VITE_INGEST_BASE_URL=' . escapeshellarg($ingest)
        . ' {{bin/pnpm}} --filter @hookubit/dashboard build',
        real_time_output: true,
    );

    $dist = '{{release_path}}/apps/dashboard/dist';
    if (!test("[ -f $dist/index.html ]")) {
        throw error('The dashboard build produced no dist/index.html.');
    }

    // Prove the ingest URL actually reached Vite, and prove the localhost
    // fallback did not survive. BOTH greps have to skip the sourcemaps:
    // vite.config.ts sets `sourcemap: true`, so dist/assets/*.js.map always
    // carries the original source line
    //
    //     return import.meta.env.VITE_INGEST_BASE_URL ?? 'http://localhost:8080'
    //
    // whether or not the fallback was taken. A map file matching the negative
    // check fails every deploy with a message saying the opposite of the truth.
    //
    // Two rules, and the option order is one of them:
    //
    //   · `--include`/`--exclude` must come BEFORE `--`, or before the pattern
    //     with no `--` at all. `grep -rqF -- PATTERN --include='*.js' dir` ends
    //     option parsing at `--`, so `--include='*.js'` becomes a FILENAME
    //     operand, grep warns that it does not exist, and the filter never
    //     applies — the maps get scanned anyway.
    //   · --exclude='*.js.map' as well as --include='*.js', because `*.js.map`
    //     does not match `*.js` on GNU grep but the two together are explicit
    //     and survive someone widening the include later.
    $assets = escapeshellarg(parse("$dist/assets"));
    $filter = "--include='*.js' --exclude='*.js.map'";
    if (!test("grep -rqF $filter " . escapeshellarg($ingest) . " $assets")) {
        throw error(
            "The built bundle does not contain $ingest.\n" .
            "VITE_INGEST_BASE_URL did not reach the build, so the get-started page will tell\n" .
            "people to publish somewhere else. Refusing to ship it.",
        );
    }
    if (test("grep -rqF $filter 'http://localhost:8080' $assets")) {
        throw error(
            "The built bundle still contains http://localhost:8080 — the VITE_INGEST_BASE_URL\n" .
            "fallback — in emitted JavaScript, not just in a sourcemap. The build did not pick\n" .
            "up the configured ingest origin.",
        );
    }

    hb_stage('built');
    info("dashboard built for $ingest");
});

desc('Builds everything, in order');
task('hookubit:build', [
    'hookubit:build:install',
    'hookubit:build:generate',
    'hookubit:build:api',
    'hookubit:build:data-plane',
    'hookubit:build:dashboard',
]);

// ---------------------------------------------------------------------------
// 5. Migrations
// ---------------------------------------------------------------------------

desc('Prints the pending migrations and names the two ordering exceptions');
task('hookubit:migrate:status', function () {
    // This task's output is the single line an operator reads to decide whether
    // the two ordering-exception migrations are in play. So it must never
    // confuse "Prisma says nothing is pending" with "Prisma never got to
    // speak". `|| true` under `set -u` did exactly that: a failed cd, an
    // unusable DATABASE_URL, a Prisma crash or any wording change all produced
    // an empty pending list and a confident "No pending migrations".
    //
    // The exit code alone does not classify the run either: `migrate status`
    // exits 1 for the perfectly ordinary "there are migrations to apply". So we
    // capture BOTH the code and the text, and refuse on anything the parser
    // does not positively recognise.
    $script = "set -u\n" . hb_env_sh() . "\n" . <<<'SH'
        DATABASE_URL="$(hb_env DATABASE_URL)"
        DIRECT_DATABASE_URL="$(hb_env DIRECT_DATABASE_URL)"
        if [ -z "$DATABASE_URL" ] || [ -z "$DIRECT_DATABASE_URL" ]; then
          echo 'HB_STATUS_EXIT=64'
          exit 0
        fi
        export DATABASE_URL DIRECT_DATABASE_URL
        if ! cd {{migrate_path}}/apps/control-api 2>/dev/null; then
          echo 'HB_STATUS_EXIT=65'
          exit 0
        fi
        out="$({{bin/pnpm}} exec prisma migrate status 2>&1)"
        rc=$?
        printf '%s\n' "$out"
        echo "HB_STATUS_EXIT=$rc"
        SH;

    $raw = run($script);

    if (!preg_match('/^HB_STATUS_EXIT=(\d+)\s*$/m', $raw, $m)) {
        hb_raw($raw);
        throw error(
            "`prisma migrate status` produced no exit marker, so the command itself did not run\n" .
            "to completion on the host (an SSH or shell failure, not a Prisma one).\n" .
            "Nothing here knows whether migrations are pending. Refusing to continue.",
        );
    }
    $rc = (int) $m[1];
    $out = trim((string) preg_replace('/^HB_STATUS_EXIT=\d+\s*$/m', '', $raw));
    if ($out !== '') {
        hb_raw($out);
    }

    if ($rc === 64) {
        throw error(
            'DATABASE_URL or DIRECT_DATABASE_URL came back EMPTY from ' . get('env_file') . ".\n" .
            "Either the key is absent, or its value did not survive extraction. Prisma would be\n" .
            "run against nothing, and \"no pending migrations\" would be a lie. Refusing.",
        );
    }
    if ($rc === 65) {
        throw error(
            'Could not enter ' . parse('{{migrate_path}}') . "/apps/control-api on the host.\n" .
            "Prisma never ran, so the pending list would be empty for the wrong reason. Refusing.",
        );
    }

    if (preg_match('/have failed|failed migrations?|in a failed state/i', $out)) {
        throw error(
            "Prisma reports a FAILED migration in the history. Resolve it by hand before\n" .
            "deploying — `prisma migrate deploy` will refuse, and a half-applied migration is\n" .
            "exactly the state the ordering rules exist to avoid.",
        );
    }
    if (str_contains($out, 'not found locally in prisma/migrations')) {
        throw error(
            "Prisma reports migrations applied in the database that this release does not have\n" .
            "on disk: the histories have DIVERGED. Deploying would run this code against a\n" .
            "schema it does not know. Read the names above and reconcile before deploying.",
        );
    }
    if (str_contains($out, 'not managed by Prisma Migrate')) {
        throw error(
            "Prisma says this database is not managed by Prisma Migrate (no _prisma_migrations\n" .
            "table, or an empty one against a non-empty schema). That needs a baseline, by hand.\n" .
            "See https://pris.ly/d/migrate-baseline. Refusing to deploy into it.",
        );
    }

    // Positively recognised, or nothing. `$pending === null` means unknown, and
    // unknown is NOT "none".
    $pending = null;
    if (preg_match('/have not yet been applied:\R(.*?)(?:\R\s*\R|$)/s', $out, $m)) {
        $names = [];
        foreach (preg_split('/\R/', $m[1]) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            if (!preg_match('/^(\d{14}_\S+)$/', $line, $mm)) {
                // A line in the pending block that is not a migration name.
                // Do not guess which of the two it is.
                $names = null;
                break;
            }
            $names[] = $mm[1];
        }
        if ($names !== null && $names !== []) {
            $pending = $names;
        }
    } elseif ($rc === 0 && str_contains($out, 'Database schema is up to date!')) {
        $pending = [];
    }

    if ($pending === null) {
        throw error(
            "`prisma migrate status` exited $rc and printed something this recipe cannot\n" .
            "classify (the output is above). It will NOT be read as \"no migrations pending\":\n" .
            "that is the line you would use to decide whether the two ordering-exception\n" .
            "migrations are in play, and being wrong about it is how 20260923000000 lands under\n" .
            "a live old router that then stops draining the outbox in silence.\n\n" .
            "Read the output. If the wording simply changed, fix the parser in\n" .
            "deployments/deployer/hookubit.php; do not widen it to a catch-all.",
        );
    }

    // -----------------------------------------------------------------------
    // Everything above read Prisma's PROSE. There is one question the prose
    // cannot answer, and it is the question a recovery deploy turns on: is the
    // database AHEAD of this release?
    //
    // `dep deploy --tag v1.3.0` is the documented way to put an older release
    // back after a bad one, so this is the RECOVERY path, not an unlikely
    // accident. The release's prisma/migrations is then a strict PREFIX of what
    // is applied, which Prisma 5.22 classifies migrationsDirectoryIsBehind -- a
    // diagnostic `migrate status` has no handler for. It falls through to
    // "Database schema is up to date!" and exit 0. Every check above passes,
    // $pending comes back empty, hookubit_schema_changed goes false, the symlink
    // swaps, the OLD router starts, and BOTH health probes still pass, because
    // readiness opens a pg pool and never runs the router's claim query. Across
    // 20260923000000_rename_fan_out_to_routing the router cannot parse
    // fan_out_cursor, ingest keeps answering 202 Accepted, and nothing is
    // delivered -- under a green deploy.
    //
    // So the two sets are compared here, directly, before anything reassuring is
    // printed or recorded. ONE extra node round trip, and nothing below may
    // print an all-clear that this comparison has not earned.
    $drift = hb_migration_drift(parse('{{migrate_path}}'));
    foreach ($drift['detail'] as $line) {
        hb_raw('  ' . $line);
    }

    // The one honest exception: a database with no _prisma_migrations table at
    // all, where Prisma independently reports every migration this release
    // carries as pending. That is a database at revision zero -- it cannot be
    // ahead of anything, and refusing it would make a first deploy impossible.
    // A missing table against a POPULATED schema is a different thing, and the
    // 'not managed by Prisma Migrate' check above already refuses it.
    $freshDatabase = $drift['status'] === 'no-migrations-table'
        && $pending !== []
        && array_diff($drift['disk'], $pending) === []
        && array_diff($pending, $drift['disk']) === [];

    if ($drift['status'] !== 'ok' && !$freshDatabase) {
        $why = match ($drift['status']) {
            'no-release' => parse('{{migrate_path}}') . ' has no apps/control-api/prisma/migrations on disk',
            'no-url' => 'DIRECT_DATABASE_URL came back empty from ' . get('env_file') .
                ' (an absent key, or a value continued onto a second line with a backslash)',
            'no-client' => 'this release has no usable @prisma/client: pruned, never generated, or generated for another platform',
            'no-migrations-on-disk' => 'this release has a prisma/migrations directory with no migrations in it',
            'no-migrations-table' => 'the database has no _prisma_migrations table, and Prisma does not report ' .
                'every migration in this release as pending either, so this is not simply a fresh database',
            'no-migrations-applied' => '_prisma_migrations records no applied migration at all -- a dump restored ' .
                'without its rows, or a hand baseline. Nothing whatever is known about this schema',
            'unfinished-migration' => 'a migration in _prisma_migrations never finished and was not rolled back: ' .
                implode(', ', $drift['unfinished']),
            default => 'the query against _prisma_migrations did not run',
        };
        throw error(
            "COULD NOT PROVE THE DATABASE IS NOT AHEAD OF THIS RELEASE. REFUSING.\n" .
            "  Reason: $why.\n\n" .
            "  `prisma migrate status` cannot answer this on its own: when the release's\n" .
            "  migrations are a strict prefix of what is applied it prints \"Database schema is up\n" .
            "  to date!\" and exits 0. So this recipe compares the two sets itself, and it will\n" .
            "  not print an all-clear it has not earned.\n\n" .
            "  Check by hand before deciding:\n" .
            "    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations\n" .
            "      ORDER BY migration_name;",
        );
    }

    $ahead = $freshDatabase ? [] : array_values(array_diff($drift['applied'], $drift['disk']));
    if ($ahead !== []) {
        $named = [];
        foreach ($ahead as $name) {
            $named[] = "    $name" . (isset(HOOKUBIT_EXCEPTION_MIGRATIONS[$name])
                ? "\n      " . HOOKUBIT_EXCEPTION_MIGRATIONS[$name]
                : '');
        }
        throw error(
            'THE DATABASE IS AHEAD OF THIS RELEASE BY ' . count($ahead) . " MIGRATION(S). REFUSING.\n\n" .
            "  Applied in the database, absent from this release's prisma/migrations:\n" .
            implode("\n", $named) . "\n\n" .
            "  This is what deploying an OLDER ref looks like -- `--tag`, or a `--revision` pin.\n" .
            "  `prisma migrate status` calls it \"up to date\" and exits 0, so without this check\n" .
            "  the deploy goes fully green: no migrations pending, symlink swapped, old router\n" .
            "  started, both health probes 200 (readiness opens a pg pool, it does not run the\n" .
            "  claim query). Across 20260923000000_rename_fan_out_to_routing the router then\n" .
            "  stops draining the outbox while ingest keeps answering 202 and nothing at all is\n" .
            "  delivered.\n\n" .
            "  Roll FORWARD with a fix: that is almost always the move. If this older release\n" .
            "  genuinely has to go live, undo the schema change by hand first (the ALTER\n" .
            "  statements are in the header of this file) and reconcile its migration directory\n" .
            "  before deploying it.",
        );
    }

    if ($drift['rolled_back'] !== []) {
        warning(
            '_prisma_migrations records ' . count($drift['rolled_back']) . ' rolled-back migration(s): ' .
            implode(', ', $drift['rolled_back']) . '. They are not counted as applied.',
        );
    }

    set('hookubit_pending_migrations', $pending);

    if ($freshDatabase) {
        info(
            'The database has no _prisma_migrations table and Prisma reports every migration in ' .
            'this release as pending, so it is at revision zero and cannot be ahead of anything.',
        );
    }

    if ($pending === []) {
        info(
            'prisma migrate status answered, and no migrations are pending. Verified directly ' .
            'against _prisma_migrations as well: all ' . count($drift['applied']) .
            ' applied migration(s) are present in this release, so the schema is already at this ' .
            'revision and the database is NOT ahead of it.',
        );
    } else {
        info(count($pending) . ' migration(s) will be applied with the data plane stopped:');
        foreach ($pending as $name) {
            writeln("  · $name");
        }
    }

    $exceptions = array_values(array_intersect($pending, array_keys(HOOKUBIT_EXCEPTION_MIGRATIONS)));
    set('hookubit_exception_migrations', $exceptions);

    if ($exceptions !== []) {
        writeln('');
        warning('ONE OF THE TWO ORDERING-EXCEPTION MIGRATIONS IS PENDING.');
        foreach ($exceptions as $name) {
            writeln("  <fg=yellow;options=bold>$name</>");
            writeln('    ' . HOOKUBIT_EXCEPTION_MIGRATIONS[$name]);
        }
        writeln('');
        writeln('This recipe applies migrations with hookubit-data-plane STOPPED, which is the');
        writeln('safe order for both of them. Two things it does NOT do for you:');
        writeln('');
        writeln('  · 20260911000000_next_attempt_at_not_null on a LARGE deliveries table wants the');
        writeln('    hand-run recipe in its own header (one transaction per step, lock_timeout 5s,');
        writeln('    CREATE INDEX CONCURRENTLY). Prisma wraps the file in a single transaction, so');
        writeln('    the NOT VALID / VALIDATE / SET NOT NULL idiom degrades to a full-table scan');
        writeln('    under an exclusive lock. Run the steps by hand first if the table is big; the');
        writeln('    migration then finds its work done.');
        writeln('  · Rolling back past either of these is NOT a symlink swap. See the header of');
        writeln('    deployments/deployer/hookubit.php and the README.');
        writeln('');

        if (!hb_flag('migration_exceptions_ack')
            && !askConfirmation('Understood — apply with the data plane stopped and continue?', false)) {
            throw error('Aborted before any downtime. Nothing was stopped and nothing was applied.');
        }
    }

    hb_stage('surveyed');
});

desc('Applies pending migrations from the NEW release (data plane must be stopped)');
task('hookubit:migrate:deploy', function () {
    // Two separate questions, and the stage only answers the first one.
    if (!hb_reached('data-plane-stopped')) {
        throw error('Refusing to migrate: hookubit:data-plane:stop has not run in this deploy.');
    }
    // The stage means the stop was attempted (see hookubit:data-plane:stop), so
    // ask systemd whether it actually took. Both exception migrations assume no
    // older worker and no older router is alive while they apply.
    $dpUnit = (string) get('data_plane_unit');
    if (test('{{bin/systemctl_query}} is-active --quiet ' . escapeshellarg($dpUnit))) {
        throw error(
            "Refusing to migrate: $dpUnit is STILL ACTIVE.\n" .
            "hookubit:data-plane:stop ran, but the unit is up -- it was restarted, or the stop\n" .
            "timed out and systemd has not finished. Both ordering-exception migrations assume no\n" .
            "older worker and no older router is alive while they apply. Check with:\n" .
            "  systemctl status $dpUnit",
        );
    }

    // Set BEFORE the command runs, not after. `prisma migrate deploy` applies
    // migrations one at a time: if the third of four fails, the schema HAS moved
    // and the failure handler must not start the old data plane against it.
    // Config set inside a task is persisted back to the master even when the
    // task then throws, which is what makes this flag survive the failure.
    $pending = has('hookubit_pending_migrations') ? (array) get('hookubit_pending_migrations') : [];
    set('hookubit_schema_changed', $pending !== []);

    run("set -eu\n" . hb_env_sh() . "\n" . <<<'SH'
        DATABASE_URL="$(hb_env DATABASE_URL)"
        DIRECT_DATABASE_URL="$(hb_env DIRECT_DATABASE_URL)"
        [ -n "$DATABASE_URL" ] || { echo 'DATABASE_URL missing from {{env_file}}' >&2; exit 64; }
        [ -n "$DIRECT_DATABASE_URL" ] || { echo 'DIRECT_DATABASE_URL missing from {{env_file}}' >&2; exit 64; }
        export DATABASE_URL DIRECT_DATABASE_URL
        cd {{release_path}}/apps/control-api
        {{bin/pnpm}} exec prisma migrate deploy
        SH, real_time_output: true);

    hb_stage('migrated');
});

// ---------------------------------------------------------------------------
// 6, 9, 10. Services
// ---------------------------------------------------------------------------

desc('Stops hookubit-data-plane (required across the two exception migrations)');
task('hookubit:data-plane:stop', function () {
    $unit = (string) get('data_plane_unit');
    set('hookubit_data_plane_was_active', test('{{bin/systemctl_query}} is-active --quiet ' . escapeshellarg($unit)));

    // The stage advances BEFORE the run, not after. TimeoutStopSec=90 plus one
    // in-flight attempt burning EGRESS_TOTAL_TIMEOUT_MS can outlast the 180 s
    // below; Deployer then kills the SSH process and throws while systemd calmly
    // carries on and the unit DOES stop. With the stage set afterwards it would
    // still read 'surveyed', and hookubit:failure would report "failed before
    // anything was stopped or swapped" -- the exact opposite of the truth, about
    // the one thing an operator needs to know. 'surveyed' is only reached at the
    // end of hookubit:migrate:status, so a failure from here on unambiguously
    // means the stop was attempted.
    //
    // This makes the stage mean "the stop was ATTEMPTED", not "the unit is
    // down", so hookubit:migrate:deploy asks systemd itself rather than
    // trusting it.
    hb_stage('data-plane-stopped');
    // Up to TimeoutStopSec=90: webhookd drains in process and one outbound
    // attempt can take a full EGRESS_TOTAL_TIMEOUT_MS on top of that.
    run('{{bin/systemctl}} stop ' . escapeshellarg($unit), timeout: 180);
    info("$unit stopped");
});

desc('Restarts hookubit-api');
task('hookubit:api:restart', function () {
    run('{{bin/systemctl}} restart ' . escapeshellarg((string) get('api_unit')), timeout: 120);
    hb_stage('api-restarted');
});

desc('Starts hookubit-data-plane');
task('hookubit:data-plane:start', function () {
    run('{{bin/systemctl}} start ' . escapeshellarg((string) get('data_plane_unit')), timeout: 120);
    hb_stage('data-plane-started');
});

// ---------------------------------------------------------------------------
// 11. Health
// ---------------------------------------------------------------------------

desc('Health-checks the control API and the data plane, and fails loudly');
task('hookubit:health', function () {
    $attempts = (int) get('health_attempts');
    $interval = (int) get('health_interval');
    $apiPort = (int) get('control_api_port');
    $probePort = (int) get('data_plane_metrics_port');

    $script = <<<SH
        live=000; ready_code=000; ready_body=''
        i=0
        while [ \$i -lt $attempts ]; do
          i=\$((i+1))
          # NORMALISE, never append. curl writes its -w string on a failed
          # transfer AND exits non-zero, so `|| echo 000` produced live=000000 --
          # which then failed the \$live = 000 test below and printed "returned
          # HTTP 000000" instead of the one diagnosis that is nearly always right
          # when a deploy's health check fails: nothing is listening.
          live=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$apiPort/health/live 2>/dev/null) || true
          [ -n "\$live" ] || live=000
          resp=\$(curl -sS --max-time 6 -w '\\n%{http_code}' http://127.0.0.1:$probePort/health/ready 2>/dev/null) || true
          [ -n "\$resp" ] || resp="\$(printf '\\n000')"
          ready_code=\$(printf '%s' "\$resp" | tail -n1)
          ready_body=\$(printf '%s' "\$resp" | sed '\$d' | tr -d '\\n')
          if [ "\$live" = "200" ] && [ "\$ready_code" = "200" ]; then
            echo "HB_OK live=\$live ready=\$ready_code body=\$ready_body"
            exit 0
          fi
          sleep $interval
        done
        echo "HB_FAIL live=\$live ready=\$ready_code body=\$ready_body"
        exit 1
        SH;

    $out = trim(run($script, timeout: ($attempts * ($interval + 12)) + 60, no_throw: true));
    hb_raw($out);

    if (str_contains($out, 'HB_OK')) {
        hb_stage('healthy');
        info("control API /health/live 200 · data plane /health/ready 200");
        return;
    }

    // Say which failure this is. Guessing at 2am is the thing this prevents.
    $diagnosis = [];
    if (preg_match('/live=(\S+)/', $out, $m) && $m[1] !== '200') {
        $diagnosis[] = $m[1] === '000'
            ? "control API: nothing is answering on 127.0.0.1:$apiPort. The unit is not running, or it refused its configuration (config refusals report every problem at once — read the whole log line)."
            : "control API /health/live returned HTTP {$m[1]}.";
    }
    if (str_contains($out, '"postgres":"connecting"')) {
        $diagnosis[] = 'data plane: PostgreSQL is CONNECTING — the pool has never been opened. That is DATABASE_URL, pg_hba.conf, or the firewall between this host and the database host. Not a blip.';
    } elseif (str_contains($out, '"postgres":"down"')) {
        $diagnosis[] = 'data plane: PostgreSQL is DOWN — a pool was opened and then lost. The database host or the network went away; the data plane will retry on a backoff rather than exit.';
    } elseif (str_contains($out, '"status":"starting"')) {
        $diagnosis[] = 'data plane: still STARTING — the probe port is bound but readiness has never flipped. It has not reached the database yet.';
    } elseif (str_contains($out, '"status":"draining"')) {
        $diagnosis[] = 'data plane: DRAINING — it is shutting down. Something is stopping it; check for a crash loop.';
    } elseif (preg_match('/ready=(\S+)/', $out, $m) && $m[1] === '000') {
        $diagnosis[] = "data plane: nothing is answering on 127.0.0.1:$probePort. Either the process is not running, or something else holds the port — Prometheus also defaults to 9090.";
    }

    foreach ([get('api_unit'), get('data_plane_unit')] as $unit) {
        writeln('');
        writeln("<fg=cyan>--- journalctl -u $unit -n 30 ---</>");
        hb_raw(run('journalctl -u ' . escapeshellarg((string) $unit) . ' -n 30 --no-pager 2>&1 || true'));
    }

    throw error(
        "HEALTH CHECK FAILED after $attempts attempts.\n\n  " . implode("\n  ", $diagnosis ?: ['see the output above']) . "\n\n" .
        "The release IS live: the symlink was swapped and the migrations were applied.\n" .
        "Read the failure guidance printed next before reaching for `dep rollback`.",
    );
});

desc('Read-only checks against the live host: toolchain, units, migrations, health, dashboard');
task('hookubit:verify', function () {
    invoke('hookubit:toolchain');
    invoke('hookubit:systemd:check');
    invoke('hookubit:migrate:status');
    invoke('hookubit:health');
    invoke('hookubit:dashboard:check');
});

// ---------------------------------------------------------------------------
// The deploy
// ---------------------------------------------------------------------------

desc('Builds, migrates with the data plane stopped, swaps, restarts, health-checks');
task('deploy', [
    'hookubit:preflight',

    // deploy:prepare spelled out rather than invoked, for one reason: its
    // deploy:env step copies .env.example to .env in every release when the
    // repo has one, and this repo has a 12 KB .env.example full of placeholder
    // values. Configuration lives in {{env_file}}, loaded by systemd. A second,
    // example-shaped .env inside the release is at best noise and at worst the
    // file something reads instead.
    'deploy:info',
    'deploy:setup',
    'deploy:lock',
    'deploy:release',
    'deploy:update_code',
    'deploy:shared',
    'deploy:writable',

    'hookubit:toolchain',
    'hookubit:systemd:check',
    'hookubit:build',
    'hookubit:migrate:status',
    'hookubit:data-plane:stop',
    'hookubit:migrate:deploy',
    'deploy:symlink',
    'hookubit:api:restart',
    'hookubit:data-plane:start',
    'hookubit:health',
    'hookubit:dashboard:check',
    'deploy:unlock',
    'deploy:cleanup',
    'deploy:success',
]);

// The lock exists from deploy:lock onwards, so the failure handler knows from
// here on that it must unlock — and that it may talk to the host at all.
after('deploy:lock', 'hookubit:stage:locked');

task('hookubit:stage:locked', function () {
    hb_stage('locked');
})->hidden();

// deploy:symlink is a stock task, so the stage is flipped by a hook. Without
// this, a failure in hookubit:api:restart would be reported as "the swap has not
// happened yet" when it has, and the guidance would name the wrong release.
after('deploy:symlink', 'hookubit:stage:symlinked');

task('hookubit:stage:symlinked', function () {
    hb_stage('symlinked');
})->hidden();

after('deploy:success', 'hookubit:notes');

desc('Prints what the deploy did not do for you');
task('hookubit:notes', function () {
    writeln('');
    info('Deployed ' . (has('hookubit_revision') ? get('hookubit_revision') : get('target')) . ' to ' . parse('{{current_path}}'));
    writeln('  · Purge the Cloudflare cache for /index.html, or browsers keep the old bundle and');
    writeln('    request asset filenames that no longer exist.');
    writeln('  · Back up ENCRYPTION_KEY somewhere the database backup is not. A restored database');
    writeln('    without it starts, accepts events, and fails every delivery at signing time.');
})->hidden();

// ---------------------------------------------------------------------------
// Failure. This recipe does NOT roll back automatically — read on.
// ---------------------------------------------------------------------------

before('deploy:failed', 'hookubit:failure');

desc('Explains the failure and says exactly what to run');
task('hookubit:failure', function () {
    // There is no deploy lock yet, so this handler declines to touch the host:
    // it must not steal a concurrent deploy's lock, and it has nothing it could
    // safely unlock. The early return is deliberate. The WORDING must not go
    // further than that, because the stage only advances at
    // after('deploy:lock'), and deploy:info, deploy:setup and deploy:release all
    // run before it — deploy:setup alone mkdir -p's {{deploy_path}}, .dep,
    // releases and shared. A failure there (wrong owner on /opt, a full disk)
    // leaves the stage at 'init' with the host already written to.
    if (!hb_reached('locked')) {
        warning(
            'Failed before deploy:lock, so nothing here is holding a lock and this handler will ' .
            'not touch the host. Nothing was stopped, migrated or swapped: the live release is ' .
            'untouched.',
        );
        writeln('  If the failure was in deploy:setup or deploy:release the host WAS written to —');
        writeln('  those create {{deploy_path}}, .dep/, releases/ and shared/. Read the error above:');
        writeln('  a local preflight failure names hosts.yml or git, a remote one names a path.');
        return;
    }

    $dp = (string) get('data_plane_unit');
    $api = (string) get('api_unit');
    $schemaChanged = has('hookubit_schema_changed') ? (bool) get('hookubit_schema_changed') : false;

    writeln('');

    if (hb_reached('symlinked')) {
        // The release is live and the database has moved. Automatic rollback
        // here would be the wrong instinct: the symlink goes back, the schema
        // does not, and across the fan_out_cursor rename that is a SILENT stall.
        if (hb_reached('healthy')) {
            // Both probes passed, so the failure is downstream of them — today
            // that means hookubit:dashboard:check. Saying "not healthy" here
            // would send the operator to the journal for the wrong service.
            warning('THE SYMLINK WAS ALREADY SWAPPED AND THIS DEPLOY IS LIVE. Both services are healthy; what failed is after them — read the error above, not the journal.');
        } else {
            warning('THE SYMLINK WAS ALREADY SWAPPED. THIS DEPLOY IS LIVE, AND IT IS NOT HEALTHY.');
        }
        writeln('');
        // ASK SYSTEMD, do not read the stage. The units are Type=simple, so
        // `systemctl start` returns 0 the moment the process forks — the
        // data-plane-started stage is reached even when webhookd dies a second
        // later. Gating this on the stage suppressed the warning in exactly the
        // case where nothing is being delivered: a crash loop.
        if (!test('{{bin/systemctl_query}} is-active --quiet ' . escapeshellarg($dp))) {
            warning("AND $dp IS NOT RUNNING: NOTHING IS BEING DELIVERED RIGHT NOW.");
            writeln('');
            writeln("  Ingest keeps answering 202 Accepted with the data plane down, so publishers");
            writeln('  see success and the backlog is invisible on the events page. Whatever you');
            writeln("  choose below, it ends with $dp running again.");
            writeln('');
            if (hb_reached('data-plane-started')) {
                writeln('  hookubit:data-plane:start DID run and returned 0 — the unit is Type=simple, so');
                writeln('  that only means the process forked. It has exited since: this is a crash loop,');
                writeln("  and `systemctl status $dp` will show the restart counter.");
            } else {
                writeln('  hookubit:data-plane:start never ran: the failure is at or before the swap, and');
                writeln('  hookubit:data-plane:stop did run.');
            }
            writeln('');
        }
        writeln('  This recipe does NOT roll back automatically here, deliberately. `dep rollback`');
        writeln('  swaps the symlink; the database does not roll back, and this platform ships no');
        writeln('  down-migrations. ' . ($schemaChanged
            ? 'This deploy DID change the schema, so a rollback puts old code against a new one.'
            : 'This deploy applied no migrations, so a rollback is comparatively safe.'));
        writeln('');
        writeln('  Look first:');
        writeln("    journalctl -u $dp -n 200 --no-pager");
        writeln("    journalctl -u $api -n 200 --no-pager");
        writeln('    dep hookubit:health');
        writeln('');
        writeln('  Then pick one:');
        writeln('    1. Roll FORWARD. Fix, push, `make deploy`. Preferred whenever the schema moved.');
        writeln('    2. Restart in place, if this looks like a dependency that was simply not ready:');
        writeln("         dep hookubit:api:restart hookubit:data-plane:start hookubit:health");
        if ($schemaChanged) {
            writeln('    3. Roll BACK, knowing what it costs:');
            writeln('         dep rollback        # warns, asks, and restarts the services for you');
            writeln('       Across 20260923000000_rename_fan_out_to_routing you must rename the column');
            writeln('       back by hand FIRST, or the old router stops draining the outbox while ingest');
            writeln('       keeps answering 202 and nothing at all is delivered:');
            writeln('         ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;');
            writeln('       Across 20260911000000_next_attempt_at_not_null, drop the constraint first:');
            writeln('         ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;');
        } else {
            writeln('    3. Roll BACK: `dep rollback` (no migrations were applied by this deploy).');
        }
    } elseif (hb_reached('data-plane-stopped')) {
        // Nothing is live yet, but the data plane is down — and whether the old
        // one can safely come back up depends on whether the schema moved.
        if ($schemaChanged) {
            warning("THE DATA PLANE IS STOPPED AND THE SCHEMA HAS ALREADY MOVED. NOTHING IS BEING DELIVERED.");
            writeln('');
            writeln("  $dp was NOT restarted on purpose. The migrations are applied, so the OLD");
            writeln('  release under current/ is old code against a new schema — which across the');
            writeln('  fan_out_cursor rename means the router stops draining the outbox while ingest');
            writeln('  keeps answering 202. Starting it would look like recovery and deliver nothing.');
            writeln('');
            writeln('  Fix the failure and re-run `make deploy`: `prisma migrate deploy` is');
            writeln('  idempotent and will find its work done. If you must restore service on the');
            writeln('  old code, undo the schema change by hand first (see the notes above).');
        } elseif (!has('hookubit_data_plane_was_active') || get('hookubit_data_plane_was_active')) {
            warning("The data plane was stopped and no migrations were applied. Starting it again on the current release.");
            run('{{bin/systemctl}} start ' . escapeshellarg($dp) . ' || true', timeout: 120);
            writeln('  Nothing changed: the release was abandoned before the symlink swap.');
            writeln('  Check it is back with: dep hookubit:health');
        } else {
            writeln("  $dp was already stopped before this deploy, and no migrations were applied.");
            writeln('  Leaving it as it was found. Nothing changed.');
        }
    } else {
        warning('Failed before anything was stopped or swapped. The live release is untouched.');
        writeln('  The half-built release directory is left in place for inspection and will be');
        writeln('  reaped by deploy:cleanup after {{keep_releases}} more successful deploys.');
    }

    writeln('');
    if (hb_reached('locked')) {
        invoke('deploy:unlock');
    }
})->hidden();

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

before('rollback', 'hookubit:rollback:before');
after('rollback', 'hookubit:rollback:after');

// Deployer registers only fail('deploy', 'deploy:failed'), so without this a
// `dep rollback` that throws anywhere stops at the first non-zero task and
// after('rollback', ...) never runs. hookubit:rollback:before has by then
// STOPPED the data plane: the symlink would be left mid-swap, the API on the
// other release, the data plane DOWN, ingest still answering 202, and the only
// output a raw Deployer exception that says nothing about delivery having
// stopped. MainCommand keys fail handlers on the command name, so this covers
// the whole expanded script including both hooks.
fail('rollback', 'hookubit:rollback:failed');

desc('Warns about what a rollback cannot undo, then stops the data plane');
task('hookubit:rollback:before', function () {
    $candidate = (string) get('rollback_candidate');
    // Plain strings for hookubit:rollback:failed. `rollback_candidate` is a
    // lazy Deployer value and would be RE-EVALUATED in the failure handler,
    // against a symlink that may by then have moved; these do not move.
    set('hookubit_rollback_candidate', $candidate);
    set('hookubit_rollback_stopped_dp', false);
    set('hookubit_rollback_aborted', false);
    set('hookubit_rollback_db_ahead', true);

    writeln('');
    warning('A ROLLBACK SWAPS THE SYMLINK. THE DATABASE DOES NOT ROLL BACK.');
    writeln('');
    writeln('  This platform ships no down-migrations, by design. If the release you are leaving');
    writeln('  applied a migration, you are about to run OLD CODE AGAINST A NEW SCHEMA.');
    writeln('');
    writeln('  The one that bites silently: 20260923000000_rename_fan_out_to_routing renamed');
    writeln('  event_outbox.fan_out_cursor to routing_cursor. An older router names the old');
    writeln('  column, so every claim fails at parse time and THE ROUTER STOPS DRAINING THE');
    writeln('  OUTBOX ENTIRELY. Ingest does not name that column, so the platform keeps answering');
    writeln('  202 Accepted: publishers see success, nothing is delivered, and the backlog is');
    writeln('  invisible on the events page. Rename it back by hand BEFORE rolling back:');
    writeln('    ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;');
    writeln('');
    writeln('  And 20260911000000_next_attempt_at_not_null: drop the constraint first, or');
    writeln('  terminal transitions from the older worker fail and already-delivered events are');
    writeln('  retried:');
    writeln('    ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;');
    writeln('');
    writeln("  Comparing _prisma_migrations against the migration directories in release $candidate ...");
    writeln('');

    $drift = hb_migration_drift(parse('{{deploy_path}}/releases/' . $candidate));
    $ahead = $drift['status'] === 'ok'
        ? array_values(array_diff($drift['applied'], $drift['disk']))
        : [];
    // Migrations the candidate has on disk that were never applied. Not drift
    // in the dangerous direction, but it means the candidate is not the release
    // whose schema this database is at either.
    $missing = $drift['status'] === 'ok'
        ? array_values(array_diff($drift['disk'], $drift['applied']))
        : [];

    if ($drift['detail'] !== []) {
        foreach ($drift['detail'] as $line) {
            hb_raw('  ' . $line);
        }
        writeln('');
    }

    // The default is DRIFT. "Could not tell" is not an all-clear: this is the
    // line an operator reads while deciding whether to hand-run an ALTER TABLE,
    // and a false green here is how `dep rollback` reports success while the
    // old router silently stops draining the outbox.
    $proven = false;
    if ($drift['status'] !== 'ok') {
        $why = match ($drift['status']) {
            'no-release' => "release $candidate has no apps/control-api/prisma/migrations on disk",
            'no-url' => 'DIRECT_DATABASE_URL came back empty from ' . get('env_file'),
            'no-client' => "release $candidate has no usable @prisma/client (pruned, or never built)",
            'no-migrations-on-disk' => "release $candidate has a prisma/migrations directory with no migrations in it",
            'no-migrations-table' => 'the database has no _prisma_migrations table at all, so nothing here can say what revision its schema is at',
            'no-migrations-applied' => '_prisma_migrations records no applied migration — a dump restored without its rows, or a hand baseline. Nothing whatever is known about this schema',
            'unfinished-migration' => 'a migration in _prisma_migrations never finished and was not rolled back, so it is FAILED and cannot appear in the comparison: ' . implode(', ', $drift['unfinished']),
            default => 'the query against _prisma_migrations did not run',
        };
        warning(
            "COULD NOT PROVE THE DATABASE IS NOT AHEAD OF RELEASE $candidate — TREAT THIS AS DRIFT.\n" .
            "  Reason: $why.\n" .
            '  Check by hand before answering: SELECT migration_name, finished_at, rolled_back_at ' .
            'FROM _prisma_migrations ORDER BY migration_name;',
        );
    } elseif ($ahead !== []) {
        warning(
            'THE DATABASE IS AHEAD OF RELEASE ' . $candidate . ' BY ' . count($ahead) . " MIGRATION(S).\n" .
            '  This rollback runs OLD CODE AGAINST A NEWER SCHEMA.',
        );
        foreach ($ahead as $name) {
            writeln("    <fg=yellow;options=bold>$name</>");
            if (isset(HOOKUBIT_EXCEPTION_MIGRATIONS[$name])) {
                writeln('      ' . HOOKUBIT_EXCEPTION_MIGRATIONS[$name]);
                writeln('      UNDO THIS BY HAND BEFORE ROLLING BACK:');
                writeln('        ' . ($name === '20260923000000_rename_fan_out_to_routing'
                    ? 'ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;'
                    : 'ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;'));
            }
        }
    } else {
        $proven = true;
        info(
            'Verified against _prisma_migrations: all ' . count($drift['applied']) .
            " applied migration(s) are present in release $candidate. The database is NOT ahead.",
        );
        if ($missing !== []) {
            warning(
                'Release ' . $candidate . ' carries ' . count($missing) . ' migration(s) that were never applied: ' .
                implode(', ', $missing) . '. Not drift in the dangerous direction, but it is not the release this schema came from either.',
            );
        }
    }

    if ($drift['rolled_back'] !== []) {
        warning(
            '_prisma_migrations records ' . count($drift['rolled_back']) . ' rolled-back migration(s): ' .
            implode(', ', $drift['rolled_back']) . '. They are not counted as applied.',
        );
    }

    // What hookubit:rollback:failed needs to decide whether bringing the data
    // plane back up would be recovery or a silent stall.
    set('hookubit_rollback_db_ahead', !$proven);

    writeln('');
    $question = $proven
        ? "Roll back to $candidate? (the database is not ahead of it)"
        : "The database may be AHEAD of $candidate. Roll back anyway?";
    if (!askConfirmation($question, false)) {
        // error() is not a GracefulShutdownException, so this DOES reach
        // fail('rollback', ...). Mark it so the handler stays quiet about a
        // half-state that does not exist.
        set('hookubit_rollback_aborted', true);
        throw error('Rollback aborted. Nothing was changed.');
    }

    // Set before the run, for the same reason hookubit:data-plane:stop does:
    // TimeoutStopSec=90 plus an in-flight attempt can outlast the 180 s below,
    // and Deployer then throws while systemd goes on and the unit does stop. The
    // flag means "the stop was ATTEMPTED"; the handler asks systemd for the rest.
    set('hookubit_rollback_stopped_dp', true);

    // The running processes hold the previous release's files open; the swap
    // alone changes nothing until they restart. Stop the data plane first, as
    // on a deploy, so nothing claims deliveries mid-swap.
    run('{{bin/systemctl}} stop ' . escapeshellarg((string) get('data_plane_unit')), timeout: 180);
})->hidden();

desc('Explains what a FAILED rollback left behind, and recovers the data plane');
task('hookubit:rollback:failed', function () {
    $dp = (string) get('data_plane_unit');
    $api = (string) get('api_unit');
    $candidate = has('hookubit_rollback_candidate') ? (string) get('hookubit_rollback_candidate') : '';
    $stopped = has('hookubit_rollback_stopped_dp') && (bool) get('hookubit_rollback_stopped_dp');
    $aborted = has('hookubit_rollback_aborted') && (bool) get('hookubit_rollback_aborted');
    $dbAhead = !has('hookubit_rollback_db_ahead') || (bool) get('hookubit_rollback_db_ahead');

    writeln('');

    // The confirmation prompt's "no" throws through error(), which is not a
    // GracefulShutdownException, so it lands here too. Nothing happened.
    if ($aborted) {
        info('Rollback declined at the confirmation prompt. Nothing was stopped and nothing was swapped.');
        return;
    }

    if (!$stopped) {
        warning('THE ROLLBACK FAILED BEFORE ANYTHING WAS STOPPED OR SWAPPED. The live release is untouched.');
        writeln('  The drift probe or the warning above it failed, which is before the point of no');
        writeln('  return. Read the error above; nothing needs recovering.');
        return;
    }

    // Past here the data plane has been stopped on purpose and the run died
    // somewhere between that and hookubit:health. Whether the symlink moved
    // decides which code is live, and that decides whether starting the data
    // plane is recovery or the silent stall this whole recipe is about. Ask the
    // host rather than guessing from the stage.
    // rollback_candidate is a bare release name ("7"); current/ points at
    // "releases/7". basename() both sides rather than assuming either shape.
    $link = trim((string) run('readlink {{deploy_path}}/current 2>/dev/null || true', no_throw: true));
    $live = $link === '' ? '' : basename($link);
    $known = $live !== '' && $candidate !== '';
    $swapped = $known && $live === basename($candidate);
    $active = test('{{bin/systemctl_query}} is-active --quiet ' . escapeshellarg($dp));

    warning('THE ROLLBACK FAILED PART-WAY THROUGH. THIS IS A HALF-STATE.');
    writeln('');
    if (!$known) {
        writeln('  current/ could not be read, so WHICH RELEASE IS LIVE IS UNKNOWN. Look by hand:');
        writeln('    readlink {{deploy_path}}/current');
    } elseif ($swapped) {
        writeln("  current/ points at $live: the swap DID happen, so the OLDER code is live.");
    } else {
        writeln("  current/ points at $live, not the candidate " . basename($candidate) . ": the swap did");
        writeln('  NOT happen, so the release that was live before this rollback is still live.');
    }
    writeln("  $api was not restarted by this run, so it may still be serving the other release's");
    writeln('  code out of its already-open files. A restart is what settles that.');
    writeln('');

    if ($active) {
        info("$dp is RUNNING, so deliveries are draining. Not touching it.");
    } elseif (!$known) {
        // Which code is live decides whether starting the data plane is recovery
        // or the silent stall. Not knowing is not a reason to guess.
        warning("$dp IS DOWN: NOTHING IS BEING DELIVERED RIGHT NOW, AND IT IS NOT BEING STARTED FOR YOU.");
        writeln('');
        writeln('  Starting it would be a guess: whether that is recovery or the silent stall in the');
        writeln('  header of this file depends on which release current/ points at, and that could');
        writeln('  not be read. Settle the symlink first, then:');
        writeln("    dep hookubit:api:restart hookubit:data-plane:start hookubit:health");
    } elseif (!$swapped) {
        // Nothing was published. The code that was live before this rollback is
        // still live, and it is the code this schema matches — the newer side.
        // Starting the data plane is plain recovery.
        warning("$dp IS DOWN: NOTHING IS BEING DELIVERED RIGHT NOW.");
        writeln('  The symlink did not move, so the release that was already live is still live and');
        writeln('  the schema matches it. Starting the data plane again on that release:');
        run('{{bin/systemctl}} start ' . escapeshellarg($dp) . ' || true', timeout: 120);
    } elseif ($dbAhead) {
        // The swap happened and the drift probe could not prove the database is
        // not ahead. Starting the older router here is exactly the failure the
        // header of this file describes: it would look like recovery and deliver
        // nothing. Refuse, loudly, and say why.
        warning("$dp IS DOWN: NOTHING IS BEING DELIVERED RIGHT NOW, AND IT IS NOT BEING STARTED FOR YOU.");
        writeln('');
        writeln("  current/ is on $live — older code — and the drift probe could NOT prove the");
        writeln('  database is not ahead of it. Starting the data plane now would look like recovery');
        writeln('  and deliver nothing: across 20260923000000_rename_fan_out_to_routing the router');
        writeln('  cannot parse fan_out_cursor, every claim fails, and ingest keeps answering 202.');
        writeln('');
        writeln('  Decide which way you are going, then finish it:');
        writeln('    · FORWARD (preferred): `make deploy` with the fix. prisma migrate deploy is');
        writeln('      idempotent and the deploy restarts both services for you.');
        writeln('    · BACK: undo the schema change by hand FIRST —');
        writeln('        ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;');
        writeln('        ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;');
        writeln('      then finish the restart below.');
    } else {
        warning("$dp IS DOWN: NOTHING IS BEING DELIVERED RIGHT NOW.");
        writeln("  The swap to $live happened and the drift probe proved the database is not");
        writeln('  ahead of it, so this older release is the code this schema matches. Starting the');
        writeln('  data plane again:');
        run('{{bin/systemctl}} start ' . escapeshellarg($dp) . ' || true', timeout: 120);
    }

    writeln('');
    writeln('  Then look, and finish the restart the failed run did not reach:');
    writeln("    journalctl -u $dp -n 200 --no-pager");
    writeln("    journalctl -u $api -n 200 --no-pager");
    writeln('    dep hookubit:api:restart hookubit:data-plane:start hookubit:health');
})->hidden();

desc('Restarts the services onto the rolled-back release and health-checks');
task('hookubit:rollback:after', function () {
    // Without this the symlink points at the old release and the services are
    // still running the new code. A rollback that changes nothing is worse than
    // no rollback: it reports success.
    invoke('hookubit:api:restart');
    invoke('hookubit:data-plane:start');
    invoke('hookubit:health');
})->hidden();
