<?php

/**
 * HookuBit — bare-metal Ubuntu deploy tasks.
 *
 * Build, migrate with the data plane stopped, swap the symlink, restart both
 * units. The one piece of cleverness is hookubit:migrate, which refuses to
 * deploy code whose migrations do not match what the database has applied.
 * Host-specific values live in deployments/deployer/hosts.yml.
 *
 * THIS DEPLOYS THE WHOLE PLATFORM, front end included. The dashboard is built
 * here, in the release, and nginx serves it off that release - so there is one
 * deploy, one trigger and one artifact set, rather than a server deploy and a
 * separate hosted front end that ship on different timelines. What that buys is
 * mostly the absence of things: no second deploy path, no build variables living
 * in a web UI, no CORS, and no cross-origin session cookie.
 */

namespace Deployer;

add('recipes', ['hookubit']);

// ---------------------------------------------------------------------------
// Defaults. Host-specific values belong in hosts.yml, never here.
// ---------------------------------------------------------------------------

set('keep_releases', 3);
set('default_timeout', 1800);           // pnpm install plus two builds
set('update_code_strategy', 'archive'); // keeps .git out of every release

set('shared_dirs', []);
set('writable_dirs', []);

// ---------------------------------------------------------------------------
// Configuration is THREE files per environment, not one.
//
//   .env                            the 9 variables BOTH planes read
//   apps/control-api/.env           the control plane's own
//   services/data-plane/.env        the data plane's own
//
// The shared nine live in ONE file precisely so they cannot drift. Two copies
// of ENCRYPTION_KEY that disagree means the control API encrypts endpoint
// signing secrets the Go worker cannot decrypt: both processes validate their
// own configuration happily and outbound signing breaks in silence. Same class
// of fault for DATABASE_URL - ingest writes events the router never reads.
//
// Every live file is called `.env` in its own directory and every template
// `.env.example`, so .gitignore's existing `.env` / `.env.*` / `!.env.example`
// covers all six at any depth. A name like `common.env` would be stageable
// with secrets in it.
//
// They are shared_files, so the live copies are
// {{deploy_path}}/shared/<path> and every release gets a symlink. /etc/hookubit
// is retired: nothing in the platform's configuration is a root file any more,
// which is why editing it no longer needs sudo.
set('shared_files', [
    '.env',
    'apps/control-api/.env',
    'services/data-plane/.env',
]);

// The files hb_env reads, IN PRECEDENCE ORDER - first match wins.
//
// This is the CONTROL PLANE's view, because the only thing the recipe reads
// configuration for is `prisma migrate deploy`, and it must see exactly what
// the control API will see. @nestjs/config walks envFilePath doing
// `config = Object.assign(dotenv.parse(file), config)`, so EARLIER entries win
// and ['.env', '../../.env'] means service-specific beats common; systemd
// resolves it the same way round, because a LATER EnvironmentFile= wins and the
// units list the common file first. Both orderings agree, and so does this one.
//
// services/data-plane/.env is deliberately NOT here. No Node process reads it,
// and a third source with no defined precedence against the other two is how
// the migration ends up pointed at a different database than the services.
set('env_files', [
    '{{deploy_path}}/shared/apps/control-api/.env',
    '{{deploy_path}}/shared/.env',
]);

// The service user's group, and the group the seeded env files are given.
// Not cosmetic: see hookubit:env.
set('service_group', 'hookubit');

// Must agree with CONTROL_API_PORT and DATA_PLANE_METRICS_PORT in the env file.
set('control_api_port', 3000);
set('data_plane_metrics_port', 9090);

// ---------------------------------------------------------------------------
// The dashboard. nginx on this box serves it off the release, so the deploy
// builds it.
//
// These two are the ONLY host-specific values the front end needs, and both are
// COMPILED IN by vite at build time - a running release cannot be reconfigured,
// only rebuilt. Neither is a secret, which is why they live in hosts.yml beside
// the ports and not in the env files.
//
//   dashboard_origin   the public origin nginx answers the dashboard AND /v1 on.
//                      One origin for both: that is the whole point of the
//                      topology (apps/docs/self-hosting/09-bare-metal-ubuntu.md,
//                      "Two constraints"). Used by hookubit:dashboard:check, and
//                      it must equal DASHBOARD_URL in the control plane's env
//                      file, which is the base of every link in outbound mail.
//   ingest_base_url    the ingest hostname, compiled in as VITE_INGEST_BASE_URL.
//                      A DIFFERENT hostname on purpose - ingest is the Go data
//                      plane, not the control API.
//
// Empty by default and REFUSED in hookubit:build rather than defaulted. A
// default here would be a guess about somebody's domain that ships itself into
// a bundle nobody can correct without a rebuild.
set('dashboard_origin', '');
set('ingest_base_url', '');

// VITE_API_TRANSPORT is NOT a host setting, because `http` is the only value a
// deploy may ever use. `mock` builds a dashboard that renders a complete,
// convincing product out of an in-memory fixture and never contacts the control
// API; it exists for screenshots. Hardcoding it here means a deploy cannot ship
// one by typo. apps/dashboard/vite.config.ts refuses to build without it at all.
set('dashboard_api_transport', 'http');

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
     * systemd EnvironmentFiles. Not `env $(grep -v '^#' file | xargs)`:
     * `MAIL_FROM=HookuBit <no-reply@example.com>` is valid there and a
     * redirection to /bin/sh here — which is also why nothing in this recipe
     * ever `source`s one of these files. So anchor on `^KEY=`, take the LAST
     * definition in a file (systemd's rule too), and strip a trailing \r,
     * trailing blanks and one layer of quotes — each of which otherwise
     * travels into the connection string and hands Prisma something that
     * cannot connect.
     *
     * SINCE THE SPLIT IT SEARCHES A LIST. {{env_files}} is in precedence
     * order and the FIRST FILE THAT DEFINES THE KEY WINS, even if it defines
     * it empty, because that is what both real parsers do: dotenv's earlier
     * envFilePath entry and systemd's later EnvironmentFile= both let
     * `DIRECT_DATABASE_URL=` in the service file shadow a value in the common
     * one. A reader that resolved that differently from the processes would be
     * worse than no reader at all.
     *
     * Four ways to fail, each with its own exit status, because the caller
     * gives each one different advice:
     *
     *   65  the value is continued onto a second line with a backslash.
     *       Truncated at the `\` a connection string usually still parses, so
     *       the migration would quietly use a DIFFERENT database than the
     *       services. Refused rather than guessed.
     *   66  no file defines the key at all.
     *   67  a file that EXISTS could not be read. Skipping it silently and
     *       falling through to the next one is the same wrong-database fault
     *       as 65, so it stops here.
     *   0 with empty output  the key is defined, with no value.
     */
    function hb_env_sh(): string
    {
        $paths = array_map(fn (string $f): string => parse($f), get('env_files'));

        return str_replace(
            ['__HB_ENV_FILE_LIST__', '__HB_ENV_FILE_NAMES__'],
            [
                implode(' ', array_map('escapeshellarg', $paths)),
                escapeshellarg(implode(', ', $paths)),
            ],
            <<<'SH'
            HB_ENV_FILES=__HB_ENV_FILE_NAMES__
            hb_env() {
              for hb_env_file in __HB_ENV_FILE_LIST__; do
                [ -e "$hb_env_file" ] || continue
                if [ ! -r "$hb_env_file" ]; then
                  echo "hb_env: $hb_env_file exists but is not readable by $(id -un)." >&2
                  return 67
                fi
                grep -q "^$1=" "$hb_env_file" || continue
                hb_env_value=$(sed -n "s|^$1=||p" "$hb_env_file" \
                  | tail -n1 | tr -d '\r' \
                  | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")
                case "$hb_env_value" in
                  *\\) echo "hb_env: $1 in $hb_env_file ends in a backslash; put it on one line." >&2
                       return 65 ;;
                esac
                printf '%s\n' "$hb_env_value"
                return 0
              done
              echo "hb_env: $1 is defined in none of: $HB_ENV_FILES" >&2
              return 66
            }
            SH
        );
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
            # hb_env's exit status says WHY it came back empty, and the caller gives
            # each reason different advice. 0 = defined but empty, 65 = backslash
            # continuation, 66 = defined nowhere, 67 = a file it could not read.
            HB_URL="$(hb_env DIRECT_DATABASE_URL)" && HB_ENVRC=0 || HB_ENVRC=$?
            printf 'HB_ENVRC=%s\n' "$HB_ENVRC"
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
            'envrc' => (int) ($all('HB_ENVRC=')[0] ?? -1),
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

desc('Installs, generates Prisma, builds the control API, the dashboard and webhookd');
task('hookubit:build', function () {
    // BOTH host settings are validated HERE, at the front of the first task that
    // does any work, because this is the only point at which a refusal is free:
    // nothing is stopped, nothing is swapped, and the live release is untouched.
    //
    // dashboard_origin is not NEEDED until hookubit:dashboard:check, which runs
    // after the symlink swap. Letting it fail there would turn one missing line
    // in hosts.yml into a red deploy over a release that is already live and
    // probably fine - an expensive way to report a typo. So it is checked where
    // the refusal costs nothing, which is here.
    $ingest = trim((string) get('ingest_base_url'));
    $origin = rtrim(trim((string) get('dashboard_origin')), '/');
    $free = "\n\n  Nothing has been built, stopped or swapped; the live release is untouched.";

    if ($ingest === '') {
        throw error(
            "REFUSING: `ingest_base_url` is not set in deployments/deployer/hosts.yml.\n\n" .
            "  It is compiled into the dashboard bundle as VITE_INGEST_BASE_URL and cannot be\n" .
            "  changed afterwards without a rebuild. Left unset the bundle falls back to\n" .
            "  http://localhost:8080, and the Get-started page then hands every operator a\n" .
            "  `curl` that cannot work - a wrong value nothing else in the platform notices,\n" .
            "  on a release that is otherwise completely healthy.\n\n" .
            "    ingest_base_url: https://hooks.hookubit.com" . $free,
        );
    }
    if ($origin === '') {
        throw error(
            "REFUSING: `dashboard_origin` is not set in deployments/deployer/hosts.yml.\n\n" .
            "  It is the public origin nginx answers BOTH the dashboard and /v1 on, and\n" .
            "  hookubit:dashboard:check needs it to prove that what the hostname serves is\n" .
            "  this release's bundle and not a stale one. It must match DASHBOARD_URL in\n" .
            "  {{deploy_path}}/shared/apps/control-api/.env.\n\n" .
            "    dashboard_origin: https://hookubit.com" . $free,
        );
    }

    run('cd {{release_path}} && {{bin/pnpm}} install --frozen-lockfile', real_time_output: true);
    // `pnpm install` alone does not produce the Prisma client.
    run('cd {{release_path}} && {{bin/pnpm}} generate', real_time_output: true);
    run('cd {{release_path}} && {{bin/pnpm}} --filter @hookubit/control-api build', real_time_output: true);
    if (!test('[ -f {{release_path}}/apps/control-api/dist/main.js ]')) {
        throw error('The control API build produced no apps/control-api/dist/main.js.');
    }

    // ----------------------------------------------------------------------
    // The dashboard. nginx serves <release>/apps/dashboard/dist as the document
    // root for {{dashboard_origin}} (guide §8), so this build is part of the
    // release the way dist/main.js and bin/webhookd are: it swaps with the
    // symlink and it rolls back with it.
    //
    // THE ENV PREFIX. `VAR=value cmd` is the correct form HERE and the wrong
    // form in the guide, and the difference is sudo. Deployer runs this over ssh
    // as {{remote_user}} with no sudo anywhere in it - `sudo` appears in this
    // recipe only inside {{bin/systemctl}} - so the prefix is an ordinary shell
    // assignment and reaches the process.
    //
    // The guide's §4 and §14 build with `sudo -u hookubit`, and there
    // `VITE_API_TRANSPORT=http sudo -u hookubit pnpm build` sets the variable on
    // SUDO, which discards it: sudoers' env_reset rebuilds the environment for
    // the target command and the variable never arrives. The form that works
    // there is `sudo -u hookubit env VAR=value pnpm build` - `env` after sudo,
    // inside the privilege change. Worth knowing even though nothing here needs
    // it, because the symptom differs by variable: the transport guard turns the
    // stripped prefix into a refused build (loud), while a stripped
    // VITE_INGEST_BASE_URL just compiles the localhost fallback in (silent).
    // That is what the bundle check below is for.
    $transport = (string) get('dashboard_api_transport');
    run(
        'cd {{release_path}} && ' .
        'VITE_API_TRANSPORT=' . escapeshellarg($transport) . ' ' .
        'VITE_INGEST_BASE_URL=' . escapeshellarg($ingest) . ' ' .
        '{{bin/pnpm}} --filter @hookubit/dashboard build',
        real_time_output: true,
    );

    // The bundle check. Two assertions over the JS that is about to be public,
    // run against the built files rather than against the command line that
    // produced them:
    //
    //   - the configured ingest origin IS in the bundle. The only proof that
    //     VITE_INGEST_BASE_URL reached vite rather than being eaten between
    //     hosts.yml and the process.
    //   - `http://localhost:8080` is NOT. That is the fallback in
    //     src/features/onboarding/publish-request.ts, so its presence IS the
    //     variable not having arrived.
    //
    // FILTERS BEFORE THE PATTERN, AND NO `--`. Written
    // `grep -rlF -e PAT dir -- --include='*.js'` the filter does nothing at all:
    // `--` ends option parsing, so `--include=*.js` becomes a filename operand,
    // grep warns about a file that is not there, searches the directory
    // unfiltered anyway, and exits 2. On the NEGATIVE assertion a bare
    // `grep … && fail` reads that 2 as "not found" and PASSES - an unfiltered
    // search reporting success. Hence three cases below rather than true/false:
    // 0 found, 1 not found, anything else grep itself failed. A check that could
    // not run is not a check that passed.
    //
    // There is deliberately NO `--exclude='*.js.map'`, for two independent
    // reasons, and the second is the one that matters. `--include='*.js'` does
    // not match `index-<hash>.js.map` in the first place - the glob is matched
    // against the whole basename - and apps/dashboard/vite.config.ts sets
    // `build.sourcemap: false`, so no map is emitted. Putting the exclude back
    // would state that a sourcemap in a release is a normal thing one filters
    // around. It is not: dist/ is a document root now, so a map is 2.9 MB of
    // frontend source on a public URL. §8's `location ~ \.map$ { return 404; }`
    // is the second line of that defence, not the first.
    $check = str_replace(
        ['__HB_INGEST__', '__HB_FALLBACK__'],
        [escapeshellarg($ingest), escapeshellarg('http://localhost:8080')],
        <<<'SH'
        cd {{release_path}}/apps/dashboard || exit 70
        [ -f dist/index.html ] || { echo 'HB_FAIL=no-index'; exit 0; }
        [ -d dist/assets ] || { echo 'HB_FAIL=no-assets'; exit 0; }

        # 0 found · 1 not found · anything else grep failed and the check is void.
        grep -rlF --include='*.js' -e __HB_INGEST__ dist/assets >/dev/null 2>&1
        case $? in
          0) ;;
          1) echo 'HB_FAIL=ingest-absent'; exit 0 ;;
          *) echo 'HB_FAIL=grep-broken-positive'; exit 0 ;;
        esac

        grep -rlF --include='*.js' -e __HB_FALLBACK__ dist/assets >/dev/null 2>&1
        case $? in
          1) ;;
          0) echo 'HB_FAIL=fallback-present'; exit 0 ;;
          *) echo 'HB_FAIL=grep-broken-negative'; exit 0 ;;
        esac

        # Belt and braces, and free: vite emits no map, so one here means someone
        # built with --sourcemap on the box.
        if [ -n "$(find dist -name '*.map' -print -quit)" ]; then
          echo 'HB_FAIL=sourcemap'; exit 0
        fi
        echo 'HB_OK'
        SH,
    );

    $out = (string) run($check, no_throw: true);
    if (!str_contains($out, 'HB_OK')) {
        $reason = preg_match('/^HB_FAIL=(\S+)\s*$/m', $out, $m) ? $m[1] : 'unknown';
        $body = match ($reason) {
            'no-index', 'no-assets' => "  `vite build` exited 0 and produced no dist/index.html or no dist/assets.\n" .
                "  Read the build output above: the likeliest cause is that it did not run at all\n" .
                "  because the pnpm filter matched nothing.",
            'ingest-absent' => "  The bundle does not contain $ingest.\n\n" .
                "  VITE_INGEST_BASE_URL did not reach vite. Vite only inlines variables it sees in\n" .
                "  its own resolved env, so an assignment that was consumed by something in between\n" .
                "  leaves the fallback compiled in instead. Check the command echoed above actually\n" .
                "  carries the prefix, and that nothing has put a `sudo` in front of it.",
            'fallback-present' => "  The bundle contains http://localhost:8080.\n\n" .
                "  That is src/features/onboarding/publish-request.ts's fallback for an unset\n" .
                "  VITE_INGEST_BASE_URL, so this release would hand every operator a Get-started\n" .
                "  `curl` pointed at their own laptop. Same cause as above.",
            'grep-broken-positive', 'grep-broken-negative' => "  grep exited with neither 0 nor 1, so the assertion did not run and nothing is known\n" .
                "  about this bundle either way. On this host that is almost always a missing\n" .
                "  `grep` or a read error under dist/assets - not a bad bundle. It refuses rather\n" .
                "  than treating \"the check could not run\" as \"the check passed\".",
            'sourcemap' => "  dist/ contains a .map file.\n\n" .
                "  apps/dashboard/vite.config.ts sets build.sourcemap: false, so this build was\n" .
                "  given --sourcemap somewhere. dist/ is nginx's document root (§8), so that map\n" .
                "  is about to be a public URL holding the complete frontend source - every\n" .
                "  comment, every internal name, every route the UI knows about.",
            default => "  The check produced no verdict:\n\n    " . str_replace("\n", "\n    ", trim($out)),
        };
        throw error("REFUSING: the dashboard bundle check failed ($reason).\n\n" . $body . $free);
    }
    info('dashboard bundle carries ' . $ingest . ', not the localhost fallback, and ships no sourcemap');

    // Into the release, not /opt/hookubit/bin, so the symlink swap and the
    // rollback carry the binary with the code it belongs to.
    run('cd {{release_path}}/services/data-plane && {{bin/go}} build -o {{release_path}}/bin/webhookd ./cmd/webhookd', real_time_output: true);
    if (!test('[ -x {{release_path}}/bin/webhookd ]')) {
        throw error('go build produced no executable at {{release_path}}/bin/webhookd.');
    }
});

desc('Seeds each MISSING shared env file from its .env.example - first deploy only');
task('hookubit:env', function () {
    // Stock deploy:env handles exactly ONE dotenv_example -> .env, so it cannot serve
    // three. It is neutered below rather than left pointed at a file that does not
    // exist, which is how it was kept quiet before and read like a typo.
    //
    // Why this is now the design, when the old comment said copying an example into a
    // release would be wrong: it is not copied into the RELEASE. It is copied once into
    // shared/, which deploy:shared then symlinks into every release. An unconfigured
    // template in shared/ is not a silent fallback either - every required variable in
    // all three templates is present with an EMPTY value, so both planes refuse to boot
    // by name instead of starting against somebody's laptop.
    //
    // deploy:shared would do the copy itself (recipe/deploy/shared.php copies
    // release -> shared only when shared lacks the file, which is exactly "first deploy
    // only", and mkdir -p's the dirname so the two nested paths work). It is done here
    // instead for one reason: `cp` carries the release file's mode, which is 0644 from
    // git archive under the deploy user's umask. These files are about to hold
    // ENCRYPTION_KEY and a database password. 0640 from the first byte, group the service
    // user, is worth one explicit `install`.
    //
    // deploy:shared's other fallback - `[ -f shared/$file ] || touch shared/$file` - is
    // the thing this task exists to get in front of. Without it a missing template means
    // an EMPTY live file, and an empty file is the one input neither plane can complain
    // about usefully.
    $shared = parse('{{deploy_path}}/shared');
    $group = get('service_group');
    $seeded = [];

    foreach (get('shared_files') as $file) {
        $file = parse($file);

        if (test("[ -f $shared/$file ]")) {
            continue;
        }
        if (!test("[ -f {{release_path}}/$file.example ]")) {
            throw error(
                "REFUSING: this release has no $file.example to seed $shared/$file from.\n\n" .
                "  All three templates are tracked, so a release that is missing one is a release\n" .
                "  built from a ref that predates the three-file split - or from a ref where the new\n" .
                "  templates were never committed. Commit them, push, and re-run.\n\n" .
                "  Seeding is not optional here: deploy:shared's fallback for a file that exists in\n" .
                "  neither place is `touch`, and an empty live env file is the one input neither\n" .
                "  plane can report usefully.",
            );
        }

        // -g, not the setgid bit on shared/. The bit is there (deploy_path is 2750
        // deploy:{{service_group}}, and mkdir inherits it), but relying on it means a host
        // set up without it gets group-unreadable configuration and a control API that
        // dies on EACCES in @nestjs/config rather than saying anything about a group.
        run("mkdir -p \"\$(dirname $shared/$file)\"");
        run("install -m 0640 -g $group {{release_path}}/$file.example $shared/$file");
        $seeded[] = "$shared/$file";
    }

    if ($seeded === []) {
        return;
    }

    warning('SEEDED ' . count($seeded) . ' env file(s) from their templates. THEY ARE NOT CONFIGURED.');
    foreach ($seeded as $path) {
        writeln("    $path");
    }
    writeln('  Every required variable in them is present and EMPTY, so both planes will refuse to');
    writeln('  boot by name until you fill them in. hookubit:migrate is about to refuse too, for');
    writeln('  DIRECT_DATABASE_URL, and it will say where that one goes.');
    writeln('  apps/docs/self-hosting/09-bare-metal-ubuntu.md section 5 is the walkthrough.');
});

// Neutered. It copies one dotenv_example to one .env in the release, and there are three
// files in three directories whose live copies belong in shared/. hookubit:env does the
// work; this keeps the stock task from also acting on a repo that has a root
// .env.example sitting right where deploy:env would look for it.
task('deploy:env', function () {
    // Intentionally empty - see hookubit:env.
})->desc('No-op: hookubit:env seeds the three shared env files instead');

desc('Refuses a schema/code mismatch, then migrates with the data plane stopped');
task('hookubit:migrate', function () {
    $probe = hb_applied(parse('{{release_path}}'));
    $ahead = array_values(array_diff($probe['applied'], $probe['disk']));

    // ONE refusal per cause, and each cause gets only advice that is true of it.
    // This used to compute $why five ways and then append one hardcoded body about
    // deploying an older ref to all of them, so "the env file is unreadable" came back
    // with three paragraphs about the router not draining and a SELECT against a table
    // that was not the problem.
    //
    // `unfinished` is Prisma's own definition of a FAILED migration and is absent from
    // `applied`, so without it the comparison would read clean over a half-applied schema.
    $controlApiEnv = parse(get('env_files')[0]);
    $commonEnv = parse(get('env_files')[1]);
    $group = get('service_group');

    [$why, $advice] = match (true) {
        $probe['status'] === 'no-release' => [
            parse('{{release_path}}') . ' has no apps/control-api/prisma/migrations',
            "  Nothing to compare the database against, so this is not a schema problem - the\n" .
            "  RELEASE is incomplete. update_code_strategy is `archive`, so the ref being deployed\n" .
            "  does not carry that directory at all. Check `branch` (or --tag/--revision) against\n" .
            "  deployments/deployer/hosts.yml, push it, and re-run.",
        ],
        $probe['status'] === 'no-url' => match ($probe['envrc']) {
            66 => [
                'DIRECT_DATABASE_URL is defined in none of the env files',
                "  It belongs in the control plane's OWN file:\n\n" .
                "    $controlApiEnv\n\n" .
                "  Not in $commonEnv, which carries only the nine variables\n" .
                "  both planes read.\n\n" .
                "  ON A FIRST DEPLOY THIS IS THE EXPECTED REFUSAL. hookubit:env has just seeded all\n" .
                "  three files from their .env.example templates and nothing in them is filled in\n" .
                "  yet. Add the line - a DIRECT connection, bypassing PgBouncer, because transaction\n" .
                "  pooling breaks DDL and the session-scoped advisory lock Prisma takes - and re-run:\n\n" .
                "    DIRECT_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/hookubit?schema=public",
            ],
            67 => [
                'an env file exists but could not be read',
                "  The DEPLOY user must be able to read it: this guard and `prisma migrate deploy`\n" .
                "  both run as that user over ssh. hookubit:env seeds 0640, owner the deploy user,\n" .
                "  group $group. Put it back:\n\n" .
                "    chmod 0640 $controlApiEnv\n" .
                "    chgrp $group  $controlApiEnv\n\n" .
                "  The SERVICE user needs the group bit for a different reason, so do not drop it:\n" .
                "  @nestjs/config does existsSync() and then readFileSync() on <release>/.env and\n" .
                "  <release>/apps/control-api/.env, which are symlinks to these files, and an EACCES\n" .
                "  there is a control API that does not boot at all. systemd reads them as root\n" .
                "  before it drops privileges and does not care either way.",
            ],
            65 => [
                'DIRECT_DATABASE_URL is continued onto a second line with a backslash',
                "  systemd joins such a value with the next line; this guard reads one line. A\n" .
                "  connection string cut at the `\\` usually still PARSES, so the services and the\n" .
                "  migration would quietly use different databases - which is why this refuses\n" .
                "  rather than reading it.\n\n" .
                "  Put the whole value on one physical line. No quotes, no `\$`, no trailing comment:\n" .
                "  the format rules are at the top of each .env.example and both parsers have to\n" .
                "  agree on every line.",
            ],
            default => [
                'DIRECT_DATABASE_URL is defined, with an empty value',
                "  The line is there with nothing after the `=`. Both planes read that as \"not\n" .
                "  configured\", so it is the same as absent - fill it in.\n\n" .
                "  Check the control plane's own file FIRST, even if you believe the value is in\n" .
                "  the common one:\n\n" .
                "    $controlApiEnv\n\n" .
                "  A key defined EMPTY there shadows the common file - for this guard and for both\n" .
                "  real parsers alike. That is deliberate, and it is the one way the three-file\n" .
                "  split can surprise you.",
            ],
        },
        $probe['status'] !== 'ok' => [
            'the _prisma_migrations query did not run',
            "  A could-not-prove, not a mismatch: no comparison was made, so nothing is known\n" .
            "  about this schema either way. In order of likelihood:\n\n" .
            "    - postgresql-client is not installed on this host:  apt install postgresql-client\n" .
            "    - DIRECT_DATABASE_URL points somewhere this host cannot reach - firewall,\n" .
            "      pg_hba.conf, or the wrong host\n" .
            "    - the password is wrong. psql runs with -w and never prompts, because over a\n" .
            "      non-interactive ssh a prompt is a stall\n\n" .
            "  What psql said, with anything URL-shaped redacted because that string holds the\n" .
            "  password:\n\n    " . str_replace("\n", "\n    ", $probe['detail']),
        ],
        $probe['unfinished'] !== [] => [
            'a migration never finished and was not rolled back: ' . implode(', ', $probe['unfinished']),
            "  That is Prisma's own definition of a FAILED migration, and it does not appear in the\n" .
            "  applied list - so without this check the comparison would read clean over a\n" .
            "  half-applied schema. Find out what actually happened to it:\n\n" .
            "    SELECT migration_name, started_at, finished_at, rolled_back_at, logs\n" .
            "      FROM _prisma_migrations WHERE finished_at IS NULL;\n\n" .
            "  Then record the decision from <release>/apps/control-api, or Prisma will keep\n" .
            "  refusing:\n\n" .
            "    pnpm exec prisma migrate resolve --rolled-back <name>   # its changes are NOT in the schema\n" .
            "    pnpm exec prisma migrate resolve --applied     <name>   # they are; you applied them by hand\n\n" .
            "  Resolving it the wrong way round leaves the schema and the history disagreeing for\n" .
            "  good, so read `logs` before you choose.",
        ],
        $ahead !== [] => [
            'the database is AHEAD of this release by ' . count($ahead) . ': ' . implode(', ', $ahead),
            "  An applied migration is not in this release. DEPLOYING AN OLDER REF LOOKS EXACTLY\n" .
            "  LIKE THIS, and `prisma migrate status` calls it \"up to date\" and exits 0 - so\n" .
            "  unchecked the deploy goes green, both health probes included, while the older router\n" .
            "  stops draining the outbox and ingest keeps answering 202 Accepted. Nothing is\n" .
            "  delivered and the backlog is invisible on the events page.\n\n" .
            "  Roll FORWARD with a fix where you can. If the older release genuinely has to go\n" .
            "  live, undo the schema by hand first and bring its migration directory with it;\n" .
            "  deployments/deployer/README.md, \"Deploying an older ref\", has the statements.\n\n" .
            "    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY 1;",
        ],
        default => [null, null],
    };
    if ($why !== null) {
        // True of every case above: the guard runs before the data-plane stop on purpose.
        throw error(
            "REFUSING: $why.\n\n" . $advice . "\n\n" .
            "  Nothing was stopped and nothing was swapped - this guard runs before the data-plane\n" .
            "  stop, so a refusal costs nothing but the time to read it.",
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

    // The two keys now live in two DIFFERENT files - DATABASE_URL in the common one,
    // DIRECT_DATABASE_URL in the control plane's - and hb_env searches both. They are
    // exported EXPLICITLY rather than left to the package.json script's own env prelude:
    // a real environment variable beats anything Prisma's dotenv reads from the release's
    // symlinked .env, so what gets migrated is exactly what this guard just compared.
    //
    // `|| true` only so that hb_env's own exit status does not trip `set -e` before the
    // message below gets a chance to name the key. hb_env has already said why on stderr.
    run("set -eu\n" . hb_env_sh() . "\n" . <<<'SH'
        DATABASE_URL="$(hb_env DATABASE_URL || true)"
        DIRECT_DATABASE_URL="$(hb_env DIRECT_DATABASE_URL || true)"
        [ -n "$DATABASE_URL" ] || { echo "DATABASE_URL is empty or undefined. hb_env searched $HB_ENV_FILES" >&2; exit 64; }
        [ -n "$DIRECT_DATABASE_URL" ] || { echo "DIRECT_DATABASE_URL is empty or undefined. hb_env searched $HB_ENV_FILES" >&2; exit 64; }
        export DATABASE_URL DIRECT_DATABASE_URL
        cd {{release_path}}/apps/control-api && {{bin/pnpm}} exec prisma migrate deploy
        SH, real_time_output: true);
});

desc('Restarts both units onto whatever current/ points at, then health-checks');
task('hookubit:restart', function () {
    run('{{bin/systemctl}} restart {{api_unit}}', timeout: 120);
    run('{{bin/systemctl}} restart {{data_plane_unit}}', timeout: 180);
    invoke('hookubit:health');
    // After the probes, not instead of them: the probes say the two units are
    // answering, and this says the hostname in front of them is serving this
    // release. Both run after the swap, so both report a failure over a release
    // that is already live, and both say so.
    invoke('hookubit:dashboard:check');
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

desc("Proves nginx serves THIS release's dashboard bundle, and that /v1 is not the SPA");
task('hookubit:dashboard:check', function () {
    // WHY THIS EXISTS AGAIN. It was dropped while Cloudflare hosted the
    // dashboard, when it could only have restated Cloudflare's own deployment
    // log. nginx on this box serves the bundle now, and that brings back exactly
    // one failure mode nothing else on the deploy path can see: an nginx `root`
    // that does not go through `current`.
    //
    // Point `root` at /opt/hookubit/releases/7/apps/dashboard/dist, or at an
    // /opt/hookubit/src left over from a hand-built install, and every deploy
    // afterwards succeeds completely - build, migrate, swap, both probes 200 -
    // while the hostname keeps serving the bundle from whenever that path was
    // last correct. The old JS talks to the new API over /v1 and mostly works,
    // which is what makes it survive. Comparing the entry module's hash is the
    // cheapest thing that notices.
    //
    // IT PROBES NGINX ON LOOPBACK, NOT THE PUBLIC NAME. `--resolve` sends the
    // right Host and SNI to 127.0.0.1, so this tests the server block and
    // nothing else. Through the real DNS name the same request also depends on
    // Cloudflare's cache, Cloudflare's health and §8's packet filter - none of
    // which this deploy changed, and any of which could fail a release that is
    // perfectly good. A deploy must not go red because an edge cached an
    // index.html. The public path is checked once per install, by hand, in §9.
    $origin = rtrim(trim((string) get('dashboard_origin')), '/');
    $host = (string) parse_url($origin, PHP_URL_HOST);
    $scheme = parse_url($origin, PHP_URL_SCHEME) === 'http' ? 'http' : 'https';
    $port = $scheme === 'http' ? 80 : 443;

    if ($host === '') {
        // hookubit:build already refused an empty dashboard_origin, so this is a
        // value that is set and unparseable rather than absent.
        throw error("`dashboard_origin` is not a URL with a hostname: " . var_export(get('dashboard_origin'), true));
    }

    $probe = str_replace(
        ['__HB_HOST__', '__HB_SCHEME__', '__HB_PORT__'],
        [escapeshellarg($host), $scheme, (string) $port],
        <<<'SH'
        HB_INDEX={{release_path}}/apps/dashboard/dist/index.html
        [ -f "$HB_INDEX" ] || { echo 'HB_FAIL=no-release-index'; exit 0; }

        # The hashed entry module, as index.html itself names it. Taken from the
        # RELEASE rather than computed, because the release's index.html is the
        # one document that is guaranteed to agree with the release's assets.
        HB_ENTRY=$(sed -n 's|.*src="\(/assets/index-[^"]*\.js\)".*|\1|p' "$HB_INDEX" | head -n1)
        [ -n "$HB_ENTRY" ] || { echo 'HB_FAIL=no-entry-in-release'; exit 0; }
        printf 'HB_ENTRY=%s\n' "$HB_ENTRY"

        # -k: the origin certificate is a Cloudflare Origin CA cert, which is not
        # publicly trusted and is not supposed to be - it is verified by
        # Cloudflare, not by this curl. Nothing secret crosses this connection and
        # it never leaves loopback.
        HB_BODY=$(curl -sS -k --max-time 10 \
          --resolve __HB_HOST__:__HB_PORT__:127.0.0.1 \
          -H 'Cache-Control: no-cache' \
          -o - -w '\nHB_CODE=%{http_code} HB_CT=%{content_type}\n' \
          __HB_SCHEME__://__HB_HOST__/ 2>&1) || { echo 'HB_FAIL=unreachable'; printf '%s\n' "$HB_BODY"; exit 0; }
        printf '%s\n' "$HB_BODY" | sed -n 's/^\(HB_CODE=.*\)$/\1/p'

        printf '%s' "$HB_BODY" | grep -qF -e "$HB_ENTRY" \
          && echo 'HB_OK' || echo 'HB_FAIL=stale-or-other'

        # And the one that matters more than the hash: /v1 must NOT be the SPA.
        # With `try_files $uri /index.html` in place, a missing or regex-stolen
        # `location ^~ /v1/` answers every API call with index.html and a 200,
        # and the dashboard then dies on JSON.parse of HTML, screen by screen.
        HB_V1=$(curl -sS -k --max-time 10 \
          --resolve __HB_HOST__:__HB_PORT__:127.0.0.1 \
          -o /dev/null -w '%{http_code} %{content_type}' \
          __HB_SCHEME__://__HB_HOST__/v1/auth/session 2>&1) || HB_V1='000 unreachable'
        printf 'HB_V1=%s\n' "$HB_V1"
        SH,
    );

    $out = (string) run($probe, no_throw: true);
    $v1 = preg_match('/^HB_V1=(.*)$/m', $out, $m) ? trim($m[1]) : '';
    $entry = preg_match('/^HB_ENTRY=(\S+)\s*$/m', $out, $m) ? $m[1] : '(not found)';

    // /v1 first: it is the more destructive of the two and its symptom is the
    // more confusing, so it gets named first when both are wrong.
    if (!str_contains($v1, 'application/json')) {
        throw error(
            "THE /v1 PROXY IS NOT IN FRONT OF THE SPA FALLBACK.\n\n" .
            "  $scheme://$host/v1/auth/session answered: $v1\n" .
            "  It must answer 401 with application/json - the control API's own\n" .
            "  {\"code\":\"unauthenticated\"}.\n\n" .
            ($v1 !== '' && str_contains($v1, 'text/html')
                ? "  text/html means the request reached `location /`'s `try_files \$uri /index.html`\n" .
                  "  and nginx served the dashboard's index.html WITH A 200. Every screen in the\n" .
                  "  dashboard then fails on JSON.parse of HTML, with nothing naming the cause.\n\n" .
                  "  Two ways to arrive there, and only one of them is a missing block:\n" .
                  "    - there is no `location ^~ /v1/` at all;\n" .
                  "    - there is, without the `^~`, and a REGEX location in the same server block\n" .
                  "      matched the path first. A regex outranks any plain prefix no matter where\n" .
                  "      in the file it appears.\n"
                : "  A 000, or a 502, is nginx or the control API unit rather than the location\n" .
                  "  blocks - hookubit:health has just passed on 127.0.0.1:{{control_api_port}}, so\n" .
                  "  look at nginx first.\n") .
            "\n  §8 of apps/docs/self-hosting/09-bare-metal-ubuntu.md is the server block.\n" .
            "  THE RELEASE IS LIVE: the symlink was swapped and both units restarted.",
        );
    }

    if (!str_contains($out, 'HB_OK')) {
        $reason = preg_match('/^HB_FAIL=(\S+)\s*$/m', $out, $m) ? $m[1] : 'unknown';
        $body = match ($reason) {
            'no-release-index' => "  This release has no apps/dashboard/dist/index.html, which hookubit:build asserts,\n" .
                "  so something removed it between the build and now.",
            'no-entry-in-release' => "  This release's index.html names no /assets/index-*.js. Either vite's output naming\n" .
                "  changed - in which case the `sed` in this task needs updating, not the server -\n" .
                "  or index.html is not the one vite wrote.",
            'unreachable' => "  nginx did not answer on 127.0.0.1:$port for Host $host. The server block may be in\n" .
                "  sites-available and not symlinked into sites-enabled, or nginx may not be running.\n" .
                "  `sudo nginx -t && systemctl status nginx`.",
            default => "  nginx answered, but what it served does not reference $entry - the entry module\n" .
                "  THIS release's index.html names.\n\n" .
                "  The cause is almost always nginx's `root`: it must be\n" .
                "    root {{deploy_path}}/current/apps/dashboard/dist;\n" .
                "  THROUGH `current`. A root naming a release directory, or an /opt/hookubit/src from\n" .
                "  a hand-built install, is correct on the day it is written and stale after the next\n" .
                "  deploy - and nothing else fails, because the old bundle still talks to /v1.\n\n" .
                "  `nginx -T | grep -A3 'server_name $host'` shows what it is actually set to.\n" .
                "  No reload is needed once it is right: nginx resolves the `current` symlink per\n" .
                "  request, so the swap is picked up without one - UNLESS someone has turned on\n" .
                "  `open_file_cache`, which caches the resolved path for its `_valid` window.\n\n" .
                "  Not a cause, because this probe never left loopback: Cloudflare's cache.",
        };
        throw error(
            "REFUSING: the hostname is not serving this release's dashboard ($reason).\n\n" . $body .
            "\n\n  THE RELEASE IS LIVE: the symlink was swapped and both units restarted. The API is\n" .
            "  the new one; only the bundle in front of it is in question.",
        );
    }

    info("nginx serves this release's $entry on $host, and /v1 answers JSON");
});

// ---------------------------------------------------------------------------
// The deploy
// ---------------------------------------------------------------------------

// Stock `deploy`, with the build, the migration and the restarts hooked in.
task('deploy')->desc('Builds, migrates with the data plane stopped, swaps, restarts, health-checks');

after('deploy:update_code', 'hookubit:build');
// Before deploy:shared, which is what turns shared/<path> into the release symlinks.
// Stock order is ... update_code, deploy:env, deploy:shared ... so this lands between
// the neutered deploy:env and deploy:shared.
before('deploy:shared', 'hookubit:env');
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
