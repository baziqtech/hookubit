/**
 * The seed's manifest, read once in init context.
 *
 * k6 scripts know nothing about the control plane: every id, URL and API key
 * comes from here, which is what keeps a scenario from silently publishing into
 * a project that no longer has the endpoints it is trying to prove something
 * about. Run `pnpm load:seed <scenario>` first; the runner does it for you.
 */

const path = __ENV.LOAD_MANIFEST;
if (!path) {
  throw new Error(
    'LOAD_MANIFEST is not set. Run through `pnpm load:<scenario>`, or pass ' +
      '-e LOAD_MANIFEST=tests/load/.artifacts/manifest-<scenario>.json',
  );
}

export const manifest = JSON.parse(open(path));

export const projectsByKey = {};
for (const p of manifest.projects) projectsByKey[p.key] = p;

/** Endpoint groups, as the sink will tag them. */
export const groups = manifest.groups;

export function endpointsInGroup(group) {
  return manifest.projects
    .flatMap((p) => p.endpoints)
    .filter((e) => e.group === group);
}

/** A stable id for this run, so verification can scope to it if it wants to. */
export const RUN_ID = __ENV.LOAD_RUN_ID || `run-${Date.now()}`;
