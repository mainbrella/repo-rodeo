# Repo Rodeo

Repo Rodeo makes a bug reproduction and its proposed repairs inspectable. The first milestone is a local, repeatable experiment around a deliberately broken editor: run the same browser reproduction against the seeded app, a correct repair, and a plausible patch that leaves the bug in place.

The standalone runner uses deterministic patches in temporary working copies. Tracked MainBrella and E2B adapters implement the scenario through their provider APIs and protected previews; full automated cloud qualification remains pending. Daytona and AI repair agents remain future work. Local temporary copies are not security sandboxes for untrusted code. The [provider contract and run guide](src/providers/README.md) describe the supported modes and evidence format.

A separate [first local Mainbrella run](notes/2026-10-11-local-mainbrella.md) tests the full sibling `../web` checkout through the running Mainbrella API and OrbStack containers. It records provisioning, protected previews, saved-workspace restores, deterministic controls, browser reconnection, interrupted capture retry, and cleanup. That historical result came from the manual harness; it does not qualify the new adapter, production, E2B, or Daytona. Its [public observation bundle](notes/evidence/mainbrella-local-20261011-01/manifest.json) supplements the sanitized result without publishing bearer preview URLs.

## Requirements

- Node.js `22.22.2` (see `.nvmrc` and `.node-version`)
- npm `10.9.7`
- Git
- Chromium installed for Playwright

From a fresh checkout:

```sh
npm ci
npx playwright install chromium
npm run experiment
```

On Linux, install browser system dependencies with `npx playwright install --with-deps chromium`. `npm run experiment` runs the baseline, correct patch, and misleading patch in separate temporary copies, then writes evidence under a unique `artifacts/<run-id>/` directory. Its `manifest.json` records assertions, traces, screenshots, command output, source/test/lockfile/patch hashes, the Git revision and dirty-worktree marker, random seed, event timings, and cleanup confirmations. Timings are local elapsed times, not cloud performance or cost measurements.

Pass a seed to repeat the randomized holdout case:

```sh
npm run experiment -- --seed 12345
```

To choose an evidence directory, use a new path; the runner refuses to overwrite an existing one:

```sh
npm run experiment -- --output artifacts/review-run
```

The randomized holdout is generated from the recorded seed and is kept out of the fixed reproduction cases. It checks whether each patch preserves a fresh editor document through the same save-and-reload path.

The experiment exits successfully only when the baseline and misleading patch reproduce the specified loss, the correct patch passes all six tests, and cleanup succeeds. Browser failures, HTTP errors, missing tests or artifacts, unexpected assertions, and changed experiment inputs fail verification. An unverified baseline stops candidate execution.

See the [recorded local manifest](examples/run-result.json) and [evidence notes](examples/README.md) for an actual result. Evidence bundles include the exact inputs used, portable reports, original Playwright output, a SHA-256 inventory, and a checksum of the manifest. Uncommitted input changes are explicitly recorded alongside the base Git SHA.

## Other commands

```sh
npm test              # unit checks for the evidence verifier
npm run typecheck
npm run repro          # browser reproduction; starts the fixture unless REPRO_BASE_URL is set
npm run fixture        # serve the fixture at http://127.0.0.1:4175/repo-rodeo-bug
npm run capture        # capture the app while a fixture server is running
```

The reproduction intentionally fails against the seeded app: five assertions fail and the reset-isolation check passes. It passes all six checks with the correct repair. The misleading patch rerenders the current draft after saving but retains the serialization bug, so the reload checks continue to fail. `REPRO_BASE_URL` can point the verifier at an already-running app, for example:

```sh
REPRO_BASE_URL=http://127.0.0.1:4175 npm run repro
```

The standalone fixture and six browser checks are under [`fixtures/editor`](fixtures/editor). `fixtures/editor/scenario.json` describes the versioned scenario; [`patches`](fixtures/editor/patches) contains the two controlled changes. The verifier runs outside the writable app copies so the controlled patches cannot change their own acceptance tests.

## Evidence and current scope

The article draft in [`blog/one-bug-three-clouds.md`](blog/one-bug-three-clouds.md) is explicitly fictional. Provider behavior, agent outcomes, lifecycle results, costs, timings, and any pull request remain planned until backed by durable run evidence. [`blog/claims.json`](blog/claims.json) is the machine-readable claim ledger; local implementation claims and provider claims must have evidence references before their status changes to `verified` or `contradicted`.

The MainBrella command implements saved-workspace restore as a filesystem experiment with fresh server processes. Native filesystem forks, memory forks, volumes, and warm pools remain separate, unimplemented modes. Capability discovery records whether each is unavailable at the provider or simply absent from the adapter. No result establishes comparable cloud performance or price.

## MainBrella experiment

Use a test account with capacity for four containers and one saved workspace, including its full-disk capture reservation. The command reads quotas before creating anything. It never seeds account entitlements or deletes existing account resources to make room.

```sh
export MAINBRELLA_API_URL=http://localhost:8787
# Set MAINBRELLA_API_KEY in your host environment.
npm run experiment -- --provider mainbrella --seed 12345 --check-idempotency
```

The default workload is the bundled editor. To repeat the full web-checkout variant from the first local run:

```sh
npm run experiment -- --provider mainbrella \
  --source ../web --source-ref ba4d74f2d649ce4bc137e3d25610f706ce1fbe9b \
  --seed 12345 --check-idempotency
```

`--source` uses an existing Git checkout and archives the pinned commit. Uncommitted files are left alone. This variant installs dependencies once, then restores three controls without another install. Both variants use the same external verifier; the web variant uses the retained TypeScript adaptations of the two fixture patches.

Every provider command writes a version-2 `result.json`, checksum, and allowlisted `observations/`. Raw API receipts, request keys, source archives, browser reports, traces, screenshots, and preview URLs stay in `private/`. Share only the sanitized result and observation files. The raw bundle is private even after previews expire.

```sh
npm run experiment -- --provider e2b       # E2B_API_KEY; native memory-fork, base template
npm run experiment -- --provider daytona   # unsupported result, exit 2
npm run experiment -- --cleanup artifacts/<run-directory>
```

Cleanup reconciles uncertain creates/saves with their persisted keys, deletes only recorded generations/workspaces, and checks inventory and known preview URLs. It writes a separate reconciliation report without replacing the original result. Retry within the API's idempotency retention window; an expired unresolved operation remains unconfirmed. API deletion does not establish physical snapshot reclamation. See the [provider run guide](src/providers/README.md) for limitations and follow-up experiments.

## E2B experiment

Set `E2B_API_KEY` in the host environment. The default mode uses one native fork
request for three branches, with explicit 30-minute sandbox lifetimes and protected
traffic. The guest pins Node `22.22.2` before preparation. E2B's persistent
filesystem-only snapshots are a separate `--mode saved-workspace` path.

The [first E2B cloud notes](notes/2026-10-11-e2b.md) record setup success and the
remaining browser-preview authorization blocker. The last cloud run stopped
before capture and confirmed API cleanup; its failed result is retained. The
subsequent redirect-auth fix passed a local Chromium check and still needs cloud
qualification. E2B does not implement MainBrella's keyed replay guarantee, and
recovery currently requires the exact original E2B key. No comparison of provider
performance or cost is claimed.
