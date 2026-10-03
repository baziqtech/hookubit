<?php

/**
 * HookuBit — bare-metal Ubuntu deploy tasks.
 *
 * Build, migrate with the data plane stopped, swap the symlink, restart both
 * units. The one piece of cleverness is hookubit:migrate, which refuses to
 * deploy code whose migrations do not match what the database has applied.
 * Host-specific values live in deployments/deployer/hosts.yml.
 */

namespace Deployer;

add('recipes', ['hookubit']);

// ---------------------------------------------------------------------------
// Defaults. Host-specific values belong in hosts.yml, never here.
// ---------------------------------------------------------------------------

set('keep_releases', 3);
set('default_timeout', 1800);           // pnpm install plus two builds
set('update_code_strategy', 'archive'); // keeps .git out of every release

// Nothing is shared on the filesystem: the only state that must survive a
// deploy is the env file, and systemd reads that from /etc.
set('shared_dirs', []);
set('shared_files', []);
set('writable_dirs', []);
set('env_file', '/etc/hookubit/hookubit.env');

// Keep deploy:env's hands off: it would copy the repo's 12 KB .env.example to
// .env in every release, and the control API reads ../../.env. Configuration
// lives in {{env_file}}, read by systemd. Do not point this at a real file.
set('dotenv_example', 'deliberately-no-such-file');

// Must agree with CONTROL_API_PORT and DATA_PLANE_METRICS_PORT in the env file.
set('control_api_port', 3000);
set('data_plane_metrics_port', 9090);

set('bin/pnpm', '/usr/bin/pnpm');
set('bin/go', '/usr/local/go/bin/go');

// Privileged: start/stop/restart only, through deployments/deployer/sudoers.d.
// Deploying as root instead? Set this to '/usr/bin/systemctl' in hosts.yml.
set('bin/systemctl', 'sudo /usr/bin/systemctl');

set('api_unit', 'hookubit-api');
set('data_plane_unit', 'hookubit-data-plane');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

if (!function_exists('Deployer\\hb_env_sh')) {
    /**
     * A shell prelude defining `hb_env KEY`, which reads one key out of the
     * systemd EnvironmentFile. Not `env $(grep -v '^#' file | xargs)`:
     * `MAIL_FROM=HookuBit <no-reply@example.com>` is valid there and a
     * redirection to /bin/sh here. So anchor on `^KEY=`, take the LAST
     * definition (systemd's rule too), and strip a trailing \r, trailing
     * blanks and one layer of quotes — each of which otherwise travels into
     * the connection string and hands Prisma something that cannot connect.
     * A value continued with a trailing backslash is REFUSED rather than read
     * as one line: truncated at the `\` it usually still parses, and would
     * then migrate a different database than the services use.
     */
    function hb_env_sh(): string
    {
        return str_replace('__HB_ENV_FILE__', escapeshellarg(parse('{{env_file}}')), <<<'SH'
            HB_ENV_FILE=__HB_ENV_FILE__
            hb_env() {
              hb_env_value=$(sed -n "s|^$1=||p" "$HB_ENV_FILE" \
                | tail -n1 | tr -d '\r' \
                | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
              case "$hb_env_value" in
                *\\) echo "hb_env: $1 in $HB_ENV_FILE ends in a backslash; put it on one line." >&2
                     return 65 ;;
              esac
              printf '%s\n' "$hb_env_value"
            }
            SH);
    }
}

if (!function_exists('Deployer\\hb_applied')) {
    /**
     * The migrations _prisma_migrations says are applied, and the ones this
     * release carries on disk — two sets, rather than Prisma's prose.
     *
     * `prisma migrate status` cannot answer "is the database AHEAD of this
     * release", which is what deploying an older ref produces: the release's
     * migrations are then a strict PREFIX of what is applied, Prisma 5.22
     * classifies that migrationsDirectoryIsBehind, `migrate status` has no
     * handler for it, and it falls through to "Database schema is up to date!"
     * and exit 0.
     *
     * `status` is 'ok' only when the comparison was really made; anything else
     * means "could not prove the database is not ahead", and the caller
     * refuses. A database with no _prisma_migrations table is a FIRST deploy:
     * applied is empty, and nothing can be ahead of nothing.
     */
    function hb_applied(string $releasePath): array
    {
        $probe = str_replace('__HB_REL__', escapeshellarg($releasePath), <<<'SH'
            HB_API=__HB_REL__/apps/control-api
            [ -d "$HB_API/prisma/migrations" ] || { echo 'HB_RESULT=no-release'; exit 0; }
            for d in "$HB_API"/prisma/migrations/*/; do
              [ -f "$d/migration.sql" ] || continue
              n=${d%/}; printf 'HB_DISK %s\n' "${n##*/}"
            done
            HB_URL="$(hb_env DIRECT_DATABASE_URL)"
            [ -n "$HB_URL" ] || { echo 'HB_RESULT=no-url'; exit 0; }
            # libpq rejects the ?schema=public that Prisma requires, so cut the
            # query string off. HB_ROWS=end proves the second query ran: without
            # it, "no rows" and "the query failed" would read the same.
            # -w: never prompt for a password. Over a non-interactive ssh a
            # prompt is a stall, and "could not connect" is the honest answer.
            PGCONNECT_TIMEOUT=10 psql "${HB_URL%%\?*}" -qtAXw -v ON_ERROR_STOP=1 \
              -c "select 'HB_TABLE=' || (to_regclass('_prisma_migrations') is not null)::text" \
              -c "select case when finished_at is null then 'HB_UNFINISHED=' else 'HB_APPLIED=' end
                    || migration_name from _prisma_migrations where rolled_back_at is null
                  union all select 'HB_ROWS=end'" 2>&1 || true
            echo 'HB_RESULT=done'
            SH);

        $raw = (string) run("set -u\n" . hb_env_sh() . "\n" . $probe, no_throw: true);
        $all = fn (string $marker): array => preg_match_all("/^$marker(\S+)\s*$/m", $raw, $m) ? $m[1] : [];
        $result = $all('HB_RESULT=')[0] ?? '';
        // `boolean::text` is 'true'/'false'; 't'/'f' is only how psql DISPLAYS
        // a boolean column. Both are accepted so a future `-c` that returns the
        // column directly cannot turn into "probe-failed" on every deploy.
        $table = $all('HB_TABLE=')[0] ?? '';

        return [
            'status' => match (true) {
                $result === 'no-release', $result === 'no-url' => $result,
                $result !== 'done' => 'probe-failed',
                // No history table: a fresh database. Nothing is applied, so
                // nothing can be ahead of this release.
                in_array($table, ['false', 'f'], true) => 'ok',
                in_array($table, ['true', 't'], true) && str_contains($raw, 'HB_ROWS=end') => 'ok',
                default => 'probe-failed',
            },
            'disk' => $all('HB_DISK '),
            'applied' => $all('HB_APPLIED='),
            'unfinished' => $all('HB_UNFINISHED='),
            // Whatever psql said for itself, with anything URL-shaped — and so
            // password-carrying — taken out before it reaches a terminal or log.
            'detail' => trim((string) preg_replace(
                ['/^HB_.*$/m', '~[a-z][a-z0-9+.-]*://\S*~i'],
                ['', '<url redacted>'],
                $raw,
            )),
        ];
    }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

desc('Installs, generates the Prisma client, builds the control API and webhookd');
task('hookubit:build', function () {
    run('cd {{release_path}} && {{bin/pnpm}} install --frozen-lockfile', real_time_output: true);
    // `pnpm install` alone does not produce the Prisma client.
    run('cd {{release_path}} && {{bin/pnpm}} generate', real_time_output: true);
    run('cd {{release_path}} && {{bin/pnpm}} --filter @hookubit/control-api build', real_time_output: true);
    if (!test('[ -f {{release_path}}/apps/control-api/dist/main.js ]')) {
        throw error('The control API build produced no apps/control-api/dist/main.js.');
    }
    // Into the release, not /opt/hookubit/bin, so the symlink swap and the
    // rollback carry the binary with the code it belongs to.
    run('cd {{release_path}}/services/data-plane && {{bin/go}} build -o {{release_path}}/bin/webhookd ./cmd/webhookd', real_time_output: true);
    if (!test('[ -x {{release_path}}/bin/webhookd ]')) {
        throw error('go build produced no executable at {{release_path}}/bin/webhookd.');
    }
});

desc('Refuses a schema/code mismatch, then migrates with the data plane stopped');
task('hookubit:migrate', function () {
    $probe = hb_applied(parse('{{release_path}}'));
    $ahead = array_values(array_diff($probe['applied'], $probe['disk']));

    // One refusal, three ways of not being able to say the schema matches this
    // code. `unfinished` is Prisma's own definition of a FAILED migration and
    // is absent from `applied`, so without it the comparison would read clean
    // over a half-applied schema.
    $why = match (true) {
        $probe['status'] === 'no-release' => parse('{{release_path}}') . ' has no apps/control-api/prisma/migrations',
        $probe['status'] === 'no-url' => 'DIRECT_DATABASE_URL came back empty from ' . get('env_file'),
        $probe['status'] !== 'ok' => 'the _prisma_migrations query did not run — is postgresql-client installed? ' . $probe['detail'],
        $probe['unfinished'] !== [] => 'a migration never finished and was not rolled back: ' . implode(', ', $probe['unfinished']),
        $ahead !== [] => 'the database is AHEAD of this release by ' . count($ahead) . ': ' . implode(', ', $ahead),
        default => null,
    };
    if ($why !== null) {
        throw error(
            "REFUSING: $why.\n\n" .
            "  This recipe will not print an all-clear it has not earned. Deploying an older ref\n" .
            "  looks exactly like the ahead case, and `prisma migrate status` calls that \"up to\n" .
            "  date\" and exits 0 — so unchecked the deploy goes green, both health probes included,\n" .
            "  while the older router stops draining the outbox and ingest keeps answering 202\n" .
            "  Accepted. Nothing is delivered. Roll FORWARD with a fix where you can; the rest is\n" .
            "  in deployments/deployer/README.md, \"Deploying an older ref\".\n\n" .
            '  SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY 1;',
        );
    }

    $pending = array_values(array_diff($probe['disk'], $probe['applied']));
    if ($pending === []) {
        info('No migrations pending; all ' . count($probe['applied']) . ' applied migration(s) are in this release.');
        return;
    }
    info(count($pending) . ' migration(s) to apply with the data plane stopped: ' . implode(', ', $pending));

    // Stopped, not merely upgraded first. Two migrations invert the usual
    // "migrate ahead of the code" rule — 20260911000000_next_attempt_at_not_null
    // needs no older worker alive, and 20260923000000_rename_fan_out_to_routing
    // has no window in which both column names exist — and with the data plane
    // down neither has an old process left to break. It costs a short pause in
    // ingest and delivery. 180s: TimeoutStopSec is 90, plus one outbound
    // attempt draining in process.
    run('{{bin/systemctl}} stop {{data_plane_unit}}', timeout: 180);

    run("set -eu\n" . hb_env_sh() . "\n" . <<<'SH'
        DATABASE_URL="$(hb_env DATABASE_URL)"; DIRECT_DATABASE_URL="$(hb_env DIRECT_DATABASE_URL)"
        [ -n "$DATABASE_URL" ] && [ -n "$DIRECT_DATABASE_URL" ] || { echo 'database URL missing from {{env_file}}' >&2; exit 64; }
        export DATABASE_URL DIRECT_DATABASE_URL
        cd {{release_path}}/apps/control-api && {{bin/pnpm}} exec prisma migrate deploy
        SH, real_time_output: true);
});

desc('Restarts both units onto whatever current/ points at, then health-checks');
task('hookubit:restart', function () {
    run('{{bin/systemctl}} restart {{api_unit}}', timeout: 120);
    run('{{bin/systemctl}} restart {{data_plane_unit}}', timeout: 180);
    invoke('hookubit:health');
});

desc('Waits for the control API and the data plane to answer their probes');
task('hookubit:health', function () {
    // curl writes its -w string AND exits non-zero on a failed transfer, so
    // `|| code=000` normalises the code rather than appending to it.
    $out = trim((string) run(<<<'SH'
        a=000; b=000
        for _ in $(seq 30); do
          a=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:{{control_api_port}}/health/live 2>/dev/null) || a=000
          b=$(curl -sS -o /dev/null -w '%{http_code}' -m 6 http://127.0.0.1:{{data_plane_metrics_port}}/health/ready 2>/dev/null) || b=000
          [ "$a$b" = 200200 ] && break || sleep 2
        done
        echo "live=$a ready=$b"
        SH, timeout: 300, no_throw: true));

    if (!str_contains($out, 'live=200 ready=200')) {
        throw error(
            "HEALTH CHECK FAILED ($out), and the release IS live: the symlink was swapped and any\n" .
            "pending migrations were applied, so going back is a schema decision, not a symlink one.\n" .
            parse('  journalctl -u {{api_unit}} -u {{data_plane_unit}} -n 100 --no-pager') . "\n" .
            parse('  curl -s localhost:{{data_plane_metrics_port}}/health/ready   # names the database state'),
        );
    }
    info('control API /health/live 200 · data plane /health/ready 200');
});

// ---------------------------------------------------------------------------
// The deploy
// ---------------------------------------------------------------------------

// Stock `deploy`, with the build, the migration and the restarts hooked in.
task('deploy')->desc('Builds, migrates with the data plane stopped, swaps, restarts, health-checks');

after('deploy:update_code', 'hookubit:build');
before('deploy:symlink', 'hookubit:migrate');
after('deploy:symlink', 'hookubit:restart');
after('deploy:failed', 'deploy:unlock');

// ---------------------------------------------------------------------------
// Rollback. The symlink rolls back; the database does not.
// ---------------------------------------------------------------------------

before('rollback', 'hookubit:rollback:warn');
after('rollback', 'hookubit:restart');

desc('Says what a rollback cannot undo, and asks');
task('hookubit:rollback:warn', function () {
    writeln('');
    warning('A ROLLBACK SWAPS THE SYMLINK. THE DATABASE DOES NOT ROLL BACK.');
    writeln('  No down-migrations ship, by design, so if the release you are leaving applied one you');
    writeln('  are about to run OLD CODE AGAINST A NEW SCHEMA. The silent case is');
    writeln('  20260923000000_rename_fan_out_to_routing: the older router names fan_out_cursor, every');
    writeln('  claim fails at parse time, the outbox stops draining, and ingest keeps answering 202.');
    writeln('  Rolling FORWARD with a fix is almost always better. Going back, undo by hand FIRST:');
    writeln('    ALTER TABLE event_outbox RENAME COLUMN routing_cursor TO fan_out_cursor;');
    writeln('    ALTER TABLE deliveries ALTER COLUMN next_attempt_at DROP NOT NULL;');
    writeln('');
    if (!askConfirmation('Roll back anyway?', false)) {
        throw error('Rollback aborted. Nothing was changed.');
    }
})->hidden();
