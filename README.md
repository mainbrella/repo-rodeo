# Repo Rodeo

Repo Rodeo makes a bug reproduction and its proposed repairs inspectable. The first milestone is a local, repeatable experiment around a deliberately broken editor: run the same browser reproduction against the seeded app, a correct repair, and a plausible patch that leaves the bug in place.

The standalone runner uses deterministic patches in temporary working copies. Tracked MainBrella, E2B, and Daytona adapters implement the scenario through their provider APIs and protected previews. The three selected modes complete the deterministic repair controls. Cleanup, preview access, recovery and process preservation are reported as separate observations, not an overall provider ranking. The [Daytona rerun notes](notes/2026-10-12-daytona-rerun.md) record the completed snapshot and cleanup evidence. AI repair agents remain future work. Local temporary copies are not security sandboxes for untrusted code. The [provider contract and run guide](src/providers/README.md) describe the supported modes and evidence format.

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

## Local egress and vault qualification

With `../backend` installed (`npm ci` there), Docker running, Python 3, OpenSSL,
and an existing local MainBrella Node image:

```sh
npm run qualify:security:local -- \
  --image <existing-local-node-image> \
  --output artifacts/security-local-<new-run>
```

This starts an isolated local API and private runtime with
`EGRESS_POLICIES_ENABLED=true` and `SECRETS_VAULT_ENABLED=true`, disposable D1
accounts, the actual relay, and a temporary TLS acknowledgment upstream. It
uses four native Docker starts and two filesystem captures, and never loads `.env`,
changes deployment configuration, or uses an existing account. The runner
inspects and pins the supplied image; it does not pull or build an image.

The checks cover encrypted vault storage, metadata-only APIs, account isolation,
admission and replay, native HTTP/HTTPS interception, domain/CIDR/mixed-DNS denial,
redirect and reflection rejection, rotation/deletion during requests, runtime
incarnation fencing, private account rollout, CA tampering, alternate-port denial,
filesystem fork/stop/resume, missing configuration, credential scans and protected HTTP
previews. Online public TCP/UDP DNS controls must succeed before restricted
denial counts. Cleanup verifies API inventories and removes only this run's
Docker namespace, including its sidecars.

`result.json` and its checksum record each check, pinned tooling/image/source
hashes, start counts, and cleanup. `inputs/` retains the runner and actual Worker
bundles without bindings or credentials. A run passes only when every check and
cleanup succeeds. Existing output directories are refused.

Local relay DNS uses fixture answers and authorized addresses map to loopback
upstreams. The Worker-to-relay HTTPS URL is bridged to authenticated loopback
HTTP. Test-only RPC hooks exercise incarnation and account configuration changes.
These observations qualify local behavior; `releaseQualified` remains false.
The report lists remaining deployed transport, bypass, lifecycle, snapshot and
ingress checks before production enablement. SIGINT/SIGTERM write a failed
report and attempt the same bounded cleanup.

The [October 12 local result](examples/mainbrella-local-security/result.json)
passed all 26 checks with two starts and complete cleanup. The
[SIGTERM result](examples/mainbrella-local-security/interrupted-result.json)
records exit 143 and complete cleanup with a restricted guest active. The full
inputs remain in `artifacts/security-local-20261012-final/inputs/`.
The test exposed and fixed the default relay fetch receiver in
`../backend/containers/account-security.js`: Workers require the stored native
fetch function to retain `globalThis`; the previous call failed before reaching
the relay. A backend regression test now covers that receiver requirement.

The reproduction intentionally fails against the seeded app: five assertions fail and the reset-isolation check passes. It passes all six checks with the correct repair. The misleading patch rerenders the current draft after saving but retains the serialization bug, so the reload checks continue to fail. `REPRO_BASE_URL` can point the verifier at an already-running app, for example:

```sh
REPRO_BASE_URL=http://127.0.0.1:4175 npm run repro
```

The standalone fixture and six browser checks are under [`fixtures/editor`](fixtures/editor). `fixtures/editor/scenario.json` describes the versioned scenario; [`patches`](fixtures/editor/patches) contains the two controlled changes. The verifier runs outside the writable app copies so the controlled patches cannot change their own acceptance tests.

## Evidence and current scope

The article draft in [`blog/one-bug-three-clouds.md`](blog/one-bug-three-clouds.md) is explicitly fictional. Provider behavior, agent outcomes, lifecycle results, costs, timings, and any pull request remain planned until backed by durable run evidence. [`blog/claims.json`](blog/claims.json) is the machine-readable claim ledger; local implementation claims and provider claims must have evidence references before their status changes to `verified` or `contradicted`.

The MainBrella command implements saved-workspace restore as a filesystem experiment with fresh server processes. Native filesystem forks, memory forks, volumes, and warm pools remain separate, unimplemented modes. Capability discovery records whether each is unavailable at the provider or simply absent from the adapter. No result establishes comparable cloud performance or price.

The [production Mainbrella run](notes/2026-10-12-production-mainbrella.md) completed
against `https://api.mainbrella.com` with the tracked runner and pinned full web
checkout. Its [result](examples/mainbrella-cloud-saved-workspace/result.json)
verifies three restores from one saved workspace, expected repair controls,
filesystem preservation, branch isolation, capture replay after successful
response headers, API job reconnection and cleanup. All four test generations
and the workspace were removed; existing account resources were preserved.

The separate [production filesystem lifecycle run](notes/2026-10-12-production-lifecycle.md)
verified the stop, resume and fork APIs. Cleanup succeeded; the result records one
unfixed JavaScript SDK finding on a late stop replay.

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
npm run experiment -- --provider daytona   # DAYTONA_API_KEY; stopped-container filesystem snapshot
npm run experiment -- --cleanup artifacts/<run-directory>
```

Cleanup reconciles uncertain creates/saves with their persisted keys, deletes only recorded generations/workspaces, and checks inventory and known preview URLs. It writes a separate reconciliation report without replacing the original result. Retry within the API's idempotency retention window; an expired unresolved operation remains unconfirmed. API deletion does not establish physical snapshot reclamation. See the [provider run guide](src/providers/README.md) for limitations and follow-up experiments.

## E2B experiment

Set `E2B_API_KEY` in the host environment. The default mode uses one native fork
request for three branches, with explicit 30-minute sandbox lifetimes and protected
traffic. The guest pins Node `22.22.2` before preparation. E2B's persistent
filesystem-only snapshots are a separate `--mode saved-workspace` path.

The [E2B cloud notes](notes/2026-10-11-e2b.md) retain the original browser-auth
failure and the successful pinned follow-up. The
[completed cloud result](examples/e2b-cloud-memory-fork/result.json) verifies one
native three-branch fork, inherited process state, independent repairs, external
browser controls, command reconnection and cleanup. Post-deletion previews returned
502 under that historical rule. The [matched follow-up](notes/2026-10-12-matched-followup.md) now treats those gateway responses as inconclusive preview evidence, separately from confirmed API deletion.
The E2B adapter does not attempt keyed capture replay, and
recovery currently requires the exact original E2B key. No comparison of provider
performance or cost is claimed.

## Daytona experiment

Set `DAYTONA_API_KEY` in the host environment. The default `saved-workspace` mode
uses a container filesystem snapshot, then creates three controls from that exact
snapshot. Preflight requires `write:sandboxes`, `delete:sandboxes`,
`write:snapshots`, and `delete:snapshots` before provisioning. Capture stops the
source container, so the source and restored servers
are explicitly relaunched. The guest pins Node `22.22.2`; private previews use an
origin-scoped token, and session recovery uses retained command output.

```sh
npm run experiment -- --provider daytona --mode saved-workspace \
  --source ../web --source-ref 3eb5f1d144324793492bed765d94bc6463614ef3 \
  --seed 12345 --check-idempotency
```

The [Daytona cloud notes](notes/2026-10-11-daytona.md) record the original
qualification attempt; the [October 12 rerun](notes/2026-10-12-daytona-rerun.md)
confirms snapshot deletion and cleanup while retaining its original preview-rule failure. New runs use the [common cleanup protocol](notes/2026-10-12-matched-followup.md) and report access denial separately from route absence and token invalidation. Container native forks are unsupported; VM memory
forks, volumes, and warm pools remain separate unimplemented experiments. Keyed
mutation replay is unsupported. Capture allows ten minutes, and each sandbox has
a 30-minute wall-clock TTL. Recovery requires the original key fingerprint.
Snapshot submission and exact-name polling have separate durable records; a
later active observation does not rewrite an expired capture's uncertain journal.
Partial results retain `preparedBaseline` and its public observations. Source
integrity remains `null` until its final comparison runs. Token invalidation,
API sandbox absence, and snapshot removal are checked separately.
No comparison of performance, physical storage, or actual charges is claimed.
