import react from '@vitejs/plugin-react';
// `Plugin` comes from `vitest/config`, not from `vite`, on purpose: vitest
// 2.x bundles Vite 5's types while the `vite` dependency here is 6, and a
// `Plugin` from the latter is not assignable to the former's `PluginOption`.
// Taking both from one place keeps this file typecheckable.
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * THE TRANSPORT GUARD.
 *
 * `VITE_API_TRANSPORT` is the only build-time variable left that can ruin a
 * deploy. There is no base-URL variable any more — nginx serves this bundle
 * and proxies `/v1` on the same origin, so relative paths are correct by
 * construction (see the note in `src/main.tsx`). What remains is that
 * `src/lib/api.ts` picks its transport with `=== 'http'`, so ANY other value,
 * unset included, selects the in-memory mock. `vite build` with the variable
 * forgotten therefore succeeds, says nothing, and ships a dashboard where
 * every screen works against data that does not exist.
 *
 * Unset is the RIGHT default for `vite dev` and for the test runner, so this
 * cannot be a runtime check and it cannot be a blanket ban on the mock —
 * a deliberate mock build for a demo or for screenshots has to stay possible.
 * The distinction the guard draws is therefore not mock-versus-http but
 * CHOSEN-versus-FORGOTTEN: say `mock` out loud and you get it, with a warning;
 * say nothing and the build refuses.
 */

const VALID = ['http', 'mock'] as const;

export type ApiTransportVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'warn'; readonly message: string }
  | { readonly kind: 'refuse'; readonly message: string; readonly summary: string };

const CONSEQUENCE =
  'A build that falls back to the mock serves the dashboard entirely from an\n' +
  '  in-memory fixture: every page renders, every list fills, every form\n' +
  '  succeeds — against data that does not exist, on a bundle that never once\n' +
  '  contacts the control API. It looks like a working product right up until\n' +
  "  somebody asks where an event went.";

const CHOICES =
  '  VITE_API_TRANSPORT=http   the real control API, at /v1 on this origin\n' +
  '  VITE_API_TRANSPORT=mock   a deliberate demo/screenshot build (allowed,\n' +
  '                            and it will say so loudly)';

const UNAFFECTED =
  '`vite dev` and `vitest` are not affected by this guard: unset is the\n' +
  '  correct setting there, and only `vite build` is checked.';

/**
 * Pure decision for one raw value of `VITE_API_TRANSPORT`, exported so it can
 * be tested without spawning a build (see `vite-config-guard.test.ts`).
 *
 * Comparison against the valid spellings is EXACT, deliberately: the bundle
 * itself does `import.meta.env.VITE_API_TRANSPORT === 'http'`, so `HTTP`,
 * `Http` and `" http "` would all miss and select the mock. Accepting them
 * here would reintroduce the same trap in a different hat. Trimming is used
 * only to recognise an all-whitespace value as missing rather than as a typo.
 */
export function evaluateApiTransport(raw: string | undefined): ApiTransportVerdict {
  if (raw === undefined || raw.trim() === '') {
    return {
      kind: 'refuse',
      summary: 'VITE_API_TRANSPORT is not set — refusing to build.',
      message:
        'VITE_API_TRANSPORT is not set, and this is a production build.\n\n' +
        '  Refusing to build, because the build would otherwise have succeeded\n' +
        '  silently and shipped the IN-MEMORY MOCK.\n\n  ' +
        CONSEQUENCE +
        '\n\n  Set it explicitly on the build:\n\n' +
        CHOICES +
        '\n\n  ' +
        UNAFFECTED,
    };
  }

  if (raw === 'http') return { kind: 'ok' };

  if (raw === 'mock') {
    return {
      kind: 'warn',
      message:
        '╔══════════════════════════════════════════════════════════════════╗\n' +
        '║  DEMO BUILD — VITE_API_TRANSPORT=mock                            ║\n' +
        '║  This bundle serves in-memory mock data and never contacts the   ║\n' +
        '║  control API. Every page carries the "Demo data" banner.         ║\n' +
        '║  Do NOT deploy it as production. Rebuild with =http for that.    ║\n' +
        '╚══════════════════════════════════════════════════════════════════╝',
    };
  }

  return {
    kind: 'refuse',
    summary: `VITE_API_TRANSPORT=${JSON.stringify(raw)} is not a recognised value — refusing to build.`,
    message:
      `VITE_API_TRANSPORT is set to ${JSON.stringify(raw)}.\n\n` +
      '  That is not a value this build recognises, so it is refusing to\n' +
      `  build. The accepted values are exactly ${VALID.map((v) => `\`${v}\``).join(' and ')} —\n` +
      '  lowercase, with no surrounding whitespace — because the bundle compares\n' +
      "  the inlined value with `=== 'http'`. The value above would not match, so\n" +
      '  the build would have fallen through to the IN-MEMORY MOCK without\n' +
      '  complaining.\n\n  ' +
      CONSEQUENCE +
      '\n\n  Set it to one of:\n\n' +
      CHOICES +
      '\n\n  ' +
      UNAFFECTED,
  };
}

/**
 * `apply: 'build'` is what makes this safe, and it is the whole reason this is
 * a plugin rather than a few lines in the exported config function. That
 * function runs for `vite build`, for `vite dev` AND for every `vitest` run —
 * Vitest loads this same file — so a check placed there would have to
 * re-derive "is this a real build?" by hand from `command`/`mode`. Verified by
 * execution rather than assumed:
 *
 *     vite build    command="build"  mode="production"   this plugin RUNS
 *     vite          command="serve"  mode="development"  not applied
 *     vitest run    command="serve"  mode="test"         not applied
 *
 * `apply: 'build'` delegates that distinction to Vite's own plugin dispatch,
 * which is the mechanism Vitest provably does not trigger, instead of to a
 * conditional of mine that would silently rot if Vitest ever changed its mode.
 *
 * It hooks `configResolved` and reads `config.env`, which is the fully
 * resolved map Vite is about to inline into `import.meta.env` — the exact
 * value the bundle will see, from the command line or from an `.env` file,
 * rather than a second guess at it from `process.env`.
 *
 * Every `vite build` is checked, not only `--mode production`: any mode other
 * than serve produces a `dist/` that someone can deploy.
 */
function requireExplicitApiTransport(): Plugin {
  let demoBuild = false;

  return {
    name: 'hookubit:require-explicit-api-transport',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      const verdict = evaluateApiTransport(config.env.VITE_API_TRANSPORT as string | undefined);

      if (verdict.kind === 'refuse') {
        // The block goes to stderr and the throw carries a one-line summary:
        // Vite prints a thrown config error with a stack trace wrapped around
        // it, and a stack is a poor frame for the thing the operator has to
        // read. This way the explanation is unmangled and the exit is still
        // non-zero.
        console.error(`\n✖  ${verdict.message}\n`);
        throw new Error(verdict.summary);
      }

      if (verdict.kind === 'warn') {
        demoBuild = true;
        console.warn(`\n${verdict.message}\n`);
      }
    },
    closeBundle() {
      // Printed again at the end on purpose. The warning above is followed by
      // a screen of chunk sizes, and the last thing on an operator's terminal
      // is the thing they actually see.
      if (demoBuild) {
        console.warn(
          '\n⚠  Built with VITE_API_TRANSPORT=mock — this dist/ serves DEMO DATA.\n',
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [requireExplicitApiTransport(), react()],
  server: {
    port: 5173,
    proxy: {
      // Talk to the control plane in development without CORS.
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  /*
   * NO SOURCEMAP IN A PRODUCTION BUILD.
   *
   * `dist/` is now served by nginx straight off the release directory, so
   * every file `vite build` writes there is a public URL on the dashboard
   * hostname. `index-<hash>.js.map` is ~2.9 MB and is the complete frontend
   * source: every comment, every internal name, every route the UI knows
   * about. Not emitting it is the only fix that does not depend on a second
   * file staying correct — a `location ~ \.map$ { return 404; }` in nginx
   * works right up until someone rewrites the server block, and a leak there
   * is silent.
   *
   * This affects `vite build` ONLY. `vite dev` serves its own sourcemaps
   * through the transform pipeline and is untouched, so day-to-day debugging
   * is unchanged. To debug a production bundle locally, ask for the map on
   * the command line for that one build — `pnpm build --sourcemap` — rather
   * than flipping it here, so the default that ships stays off.
   */
  build: { outDir: 'dist', sourcemap: false },
  test: {
    // Playwright specs live under e2e/ and run against the real stack via
    // `pnpm test:e2e`; vitest must not try to collect them.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
