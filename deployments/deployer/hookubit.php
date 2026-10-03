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
 *   5. hookubit:migrate:status    PRINTS pending migrations, names exceptions
 *   6. hookubit:data-plane:stop
 *   7. hookubit:migrate:deploy    from the NEW release
 *   8. deploy:symlink             the atomic swap
 *   9. hookubit:api:restart
 *  10. hookubit:data-plane:start
 *  11. hookubit:health            /health/live + /health/ready, fails loudly
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

// Escape hatches, both off. `dep deploy -o allow_stale_ref=true`.
set('allow_stale_ref', false);
set('migration_exceptions_ack', false);

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

    try {
        $lsRemote = runLocally(
            "$git ls-remote " . escapeshellarg($repo) . ' '
            . escapeshellarg("refs/heads/$target") . ' ' . escapeshellarg("refs/tags/$target"),
            env: $env,
        );
    } catch (\Throwable $e) {
        throw error(
            "Could not read `$target` from $repo.\n" .
            "The guard cannot tell whether you are about to deploy stale code, so it refuses.\n" .
            "Check your credentials for the remote, then retry.\n\n" . $e->getMessage(),
        );
    }

    if (!preg_match('/^([0-9a-f]{40})\s/m', $lsRemote, $m)) {
        throw error(
            "`$target` does not exist on $repo.\n" .
            "Deployer deploys what the SERVER can clone. Push the branch (or pick another with --branch) first.",
        );
    }
    $remote = $m[1];

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
            "(see deployments/deployer/README.md, 'Privileges').",
        );
    }
    foreach (['DATABASE_URL', 'DIRECT_DATABASE_URL'] as $key) {
        if (!test("grep -q " . escapeshellarg("^$key=") . ' ' . escapeshellarg($envFile))) {
            throw error("$key is not set in $envFile. Prisma needs both URLs; with no pooler they are the same string.");
        }
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

    // Prove the ingest URL actually reached Vite. --include='*.js' keeps the
    // sourcemaps out of it: dist/**/*.js.map carries the original source, which
    // contains the localhost fallback whether or not it was used.
    $assets = "$dist/assets";
    if (!test("grep -rqF -- " . escapeshellarg($ingest) . " --include='*.js' $assets")) {
        throw error(
            "The built bundle does not contain $ingest.\n" .
            "VITE_INGEST_BASE_URL did not reach the build, so the get-started page will tell\n" .
            "people to publish somewhere else. Refusing to ship it.",
        );
    }
    if (test("grep -rqF -- 'http://localhost:8080' --include='*.js' $assets")) {
        throw error(
            "The built bundle still contains http://localhost:8080 — the VITE_INGEST_BASE_URL\n" .
            "fallback. The build did not pick up the configured ingest origin.",
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
    $out = run(<<<'SH'
        set -u
        DATABASE_URL="$(sed -n 's|^DATABASE_URL=||p' {{env_file}} | tail -n1)"
        DIRECT_DATABASE_URL="$(sed -n 's|^DIRECT_DATABASE_URL=||p' {{env_file}} | tail -n1)"
        export DATABASE_URL DIRECT_DATABASE_URL
        cd {{migrate_path}}/apps/control-api
        {{bin/pnpm}} exec prisma migrate status 2>&1 || true
        SH);

    hb_raw($out);

    if (preg_match('/failed migrations?|in a failed state/i', $out)) {
        throw error(
            "Prisma reports a FAILED migration in the history. Resolve it by hand before\n" .
            "deploying — `prisma migrate deploy` will refuse, and a half-applied migration is\n" .
            "exactly the state the ordering rules exist to avoid.",
        );
    }

    $pending = [];
    if (preg_match('/have not yet been applied:?\s*(.*?)(?:\n\s*\n|$)/s', $out, $m)) {
        foreach (preg_split('/\R/', $m[1]) as $line) {
            $line = trim($line);
            if (preg_match('/^(\d{14}_\S+)$/', $line, $mm)) {
                $pending[] = $mm[1];
            }
        }
    }

    set('hookubit_pending_migrations', $pending);

    if ($pending === []) {
        info('No pending migrations: the schema is already at this revision.');
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
    if (!hb_reached('data-plane-stopped')) {
        throw error('Refusing to migrate: hookubit:data-plane:stop has not run in this deploy.');
    }

    // Set BEFORE the command runs, not after. `prisma migrate deploy` applies
    // migrations one at a time: if the third of four fails, the schema HAS moved
    // and the failure handler must not start the old data plane against it.
    // Config set inside a task is persisted back to the master even when the
    // task then throws, which is what makes this flag survive the failure.
    $pending = has('hookubit_pending_migrations') ? (array) get('hookubit_pending_migrations') : [];
    set('hookubit_schema_changed', $pending !== []);

    run(<<<'SH'
        set -eu
        DATABASE_URL="$(sed -n 's|^DATABASE_URL=||p' {{env_file}} | tail -n1)"
        DIRECT_DATABASE_URL="$(sed -n 's|^DIRECT_DATABASE_URL=||p' {{env_file}} | tail -n1)"
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
    // Up to TimeoutStopSec=90: webhookd drains in process and one outbound
    // attempt can take a full EGRESS_TOTAL_TIMEOUT_MS on top of that.
    run('{{bin/systemctl}} stop ' . escapeshellarg($unit), timeout: 180);
    hb_stage('data-plane-stopped');
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
          live=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$apiPort/health/live 2>/dev/null || echo 000)
          resp=\$(curl -sS --max-time 6 -w '\\n%{http_code}' http://127.0.0.1:$probePort/health/ready 2>/dev/null || printf '\\n000')
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

desc('Read-only checks against the live host: toolchain, units, migrations, health');
task('hookubit:verify', function () {
    invoke('hookubit:toolchain');
    invoke('hookubit:systemd:check');
    invoke('hookubit:migrate:status');
    invoke('hookubit:health');
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
    // Preflight failures happen before any connection. Do not open one now.
    if (!hb_reached('locked')) {
        warning('Failed before the host was touched. Nothing was changed, nothing was connected to.');
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
        warning('THE SYMLINK WAS ALREADY SWAPPED. THIS DEPLOY IS LIVE, AND IT IS NOT HEALTHY.');
        writeln('');
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

desc('Warns about what a rollback cannot undo, then stops the data plane');
task('hookubit:rollback:before', function () {
    $candidate = (string) get('rollback_candidate');

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
    writeln("  Asking Prisma whether the database is ahead of release $candidate ...");
    writeln('');

    set('migrate_path', '{{deploy_path}}/releases/' . $candidate);
    $out = run(<<<'SH'
        set -u
        DATABASE_URL="$(sed -n 's|^DATABASE_URL=||p' {{env_file}} | tail -n1)"
        DIRECT_DATABASE_URL="$(sed -n 's|^DIRECT_DATABASE_URL=||p' {{env_file}} | tail -n1)"
        export DATABASE_URL DIRECT_DATABASE_URL
        cd {{migrate_path}}/apps/control-api 2>/dev/null || { echo 'HB_NO_RELEASE'; exit 0; }
        {{bin/pnpm}} exec prisma migrate status 2>&1 || true
        SH);
    hb_raw($out);

    if (str_contains($out, 'HB_NO_RELEASE')) {
        warning("Could not inspect release $candidate — it has no apps/control-api. Judge for yourself.");
    } elseif (preg_match('/applied to the database but missing from the local migrations directory|not found in the local migrations directory|database schema is not in sync/i', $out)) {
        warning("THE DATABASE IS AHEAD OF RELEASE $candidate. This rollback runs old code against a newer schema.");
    } else {
        info("Prisma reports no migrations applied beyond what release $candidate contains.");
    }

    writeln('');
    if (!askConfirmation("Roll back to $candidate anyway?", false)) {
        throw error('Rollback aborted. Nothing was changed.');
    }

    // The running processes hold the previous release's files open; the swap
    // alone changes nothing until they restart. Stop the data plane first, as
    // on a deploy, so nothing claims deliveries mid-swap.
    run('{{bin/systemctl}} stop ' . escapeshellarg((string) get('data_plane_unit')), timeout: 180);
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
