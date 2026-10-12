# Repo Rodeo

Repo Rodeo makes a bug reproduction and its proposed repairs inspectable. The first milestone is a local, repeatable experiment around a deliberately broken editor: run the same browser reproduction against the seeded app, a correct repair, and a plausible patch that leaves the bug in place.

The standalone runner uses deterministic patches. It does not run AI agents or connect to E2B, Daytona, or MainBrella. The provider adapters are future work; [the provider interface](src/providers/interface.ts) and [acceptance plan](src/providers/README.md) record the planned contract. The local runner uses separate temporary working copies and an external verifier, but these are not security sandboxes and provide no isolation guarantee for untrusted code.

A separate [first local Mainbrella run](notes/2026-10-11-local-mainbrella.md) tests the full sibling `../web` checkout through the running Mainbrella API and OrbStack containers. It records provisioning, protected previews, saved-workspace restores, deterministic controls, browser reconnection, interrupted capture retry, and cleanup. This is a manual local integration run; it does not qualify production, E2B, or Daytona.

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

When MainBrella work begins, first check whether the deployment advertises filesystem forking and try its native `POST /containers/fork` path when available. If it is unavailable, test saved-workspace restore as a separate fresh-process experiment. Neither path should be described as memory preservation without evidence of preserved process state. Provider adapters, real cloud runs, agent execution, pricing comparisons, and publication are outside this milestone.
