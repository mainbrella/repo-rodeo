# Provider acceptance plan

**Status: MainBrella saved-workspace adapter implemented; new adapter end-to-end qualification pending.** The [manual local run](../../notes/2026-10-11-local-mainbrella.md) exercises the real API and OrbStack containers. It is evidence for that historical harness, not automatic qualification of this implementation. E2B, Daytona, and production comparison runs remain planned.

## Tracked command

From the repository root, after `npm ci` and `npx playwright install chromium`:

```sh
# MAINBRELLA_API_KEY is required; MAINBRELLA_API_URL defaults to http://localhost:8787.
npm run experiment -- --provider mainbrella --seed 12345 --check-idempotency
```

An explicit remote API must use HTTPS. The result records local versus cloud scope; changing the endpoint does not establish cloud qualification. The default source is the bundled fixture. `--source /path/to/web --source-ref <commit>` uses a pinned MainBrella web tree with `notes/patches/web-*.patch`, installs dependencies once, and runs the web type check before capture. Host source files are never patched. A tracked non-template `.env` file is rejected before upload.

The command creates one prepared source, verifies its baseline, captures it with `stop:false`, and restores baseline/correct/misleading branches. It compares source and dependency hashes, permissions, symlinks, independent markers, and in-memory server nonces, then uses the unchanged six-test verifier outside all guests. Servers are explicitly restarted after filesystem restore. The standalone fixture has no dependency installation step; its result says so.

`--check-idempotency` discards the first successful capture response body **after receiving successful response headers**, then retries and replays the exact persisted key/body. The journal records acceptance, each attempt, and accounting inventories. This tests response loss after backend completion, not a timeout before admission and not a disconnect during provider capture. It uses the same single workspace as the restore experiment. Concurrent account saves or a UTC-month rollover invalidate the accounting comparison; use a quiet test account.

The reconnection check detaches an API SSE client during an eight-second managed job. A new client recovers the execution ID, final status, retained output and remaining events from its cursor. It does not automate login or dashboard/browser-session reconnection; the historical manual run documents that distinct check.

Quota preflight requires space for four generations and one full-disk save, including live workspace, monthly capture and retained capture budgets. The API remains authoritative for starts, compute allowance, deadlines and races. The runner neither adjusts quotas nor creates trial/funding fixtures. Host/guest versions and requested CPU/RAM/disk are recorded separately; observed resource enforcement and billing remain unmeasured.

## Result and recovery contract

All three provider selections emit [`ExperimentResult` schema version 2](../experiment-result.ts). E2B/Daytona currently emit `unsupported` without network requests, with exit 2. MainBrella's `saved-workspace` is the only implemented mode. `filesystem-fork`, `memory-fork`, `volume`, and `warm-pool` retain distinct names and report `unsupported` or `not-implemented` from discovery; the runner does not silently substitute a restore. The default standalone `--provider local` runner retains its original version-1 manifest.

- Exit 0: expected controls, implemented lifecycle checks, input integrity and API cleanup confirmed.
- Exit 1: a failed or unverified operation, check or cleanup; partial evidence is retained.
- Exit 2: the chosen adapter or experiment mode is unavailable.

Each new output directory contains `result.json`, `result.sha256`, `observations/`, and `private/`. Only the first three are intended for sharing. Observation export allowlists document fields, omits arbitrary metadata, and redacts URLs/credentials. Those observations supplement the result; re-running the strict verifier also requires private trace/screenshot artifacts. `private/` contains the exact inputs, archive, patches, before/after observations, browser results, request journals, each response attempt, and ownership records. Its request/response files have private permissions; provider API credentials are not journaled or uploaded. Protected preview URLs are bearer credentials and remain private.

Operations persist a stable name, generated idempotency key, exact body, and timestamps before network submission. Retries preserve the body and key. MainBrella preview issuance is not idempotent and is never blindly replayed. Cleanup also handles unknown preview issuance by destroying its owned generation.

Before the result is finalized, the current journal is copied into
`private/journal-snapshot/`. The result hashes that snapshot and the retained
inputs/artifacts; it excludes the live `operations/`, `owned/`, and `receipts/`
directories that recovery may extend. Cleanup retries preserve the original
checksummed evidence.

```sh
npm run experiment -- --cleanup artifacts/<run-directory>
```

Use the same account key. Recovery replays unresolved create/capture requests only within their retention window and removes exact recorded generations/workspace IDs. Generation reuse cannot authorize deletion of the replacement. A lost response outside retention, corrupt journal, or inconclusive inventory leaves cleanup unconfirmed. The original result is immutable; recovery writes a separate timestamped report. Catchable signals enter cleanup; after a hard kill, use this command.

API deletion revokes restores and releases live quota, but it is **not proof of physical snapshot deletion**. No Docker pruning is performed. The [first-run follow-up](../../notes/2026-10-11-local-mainbrella.md#accounting-and-follow-up) records a prospective physical-retention deadline and independent scoped inventory checks. Full-disk capture reservations, measured capture bytes, Docker image size, and unique physical disk consumption are separate quantities. Pricing comparison is deferred until matched cloud runs and actual charges are available.

## Acceptance plan

Use one pinned source commit, lockfile, scenario, external Playwright suite, image, prompt/agent configuration, and resource request across comparable runs. Record source, test, lockfile, patch, and scenario hashes plus the holdout seed. Keep the verifier and exported evidence outside provider sandboxes. Local temporary file copies do not qualify as cloud isolation.

## Acceptance experiments

| Experiment | Procedure | Acceptance evidence |
| --- | --- | --- |
| 1. Capability and baseline | Record `capabilities()`, create the source sandbox, install dependencies, start the app, and run the reproduction before any repair. | Operation receipts and raw output. The baseline reproduces the expected first-block loss. An unexpected pass or setup failure is reported as such; it is not a reproduced bug. |
| 2. Deterministic controls | Apply the same correct and misleading patches used by the local experiment, each in its own attempt, and run the external verifier. | Correct control passes; misleading control retains the failure. Record patch hashes, assertions, traces, screenshots, stdout/stderr, and exit status. |
| 3. Prepared branches | Capture the prepared, dependency-installed state, then spawn three branches from that one prepared state. | Capture/spawn receipts, installed-dependency evidence, and checkout hashes. Each branch starts at the expected source hash; a write in one branch does not alter either other branch or the prepared source. Record failed isolation as a result. |
| 4. State semantics | Before capture, start a server that reports a random process nonce and PID. Observe it before capture, in each spawned branch, after stop/resume, and after any filesystem restore. | Record nonce, PID, reachability, timestamps, and operation receipts. Compare filesystem and process observations separately. A new PID or missing nonce can be a valid filesystem-only result; do not require memory preservation where unsupported. |
| 5. Preview, browser verification, and reattach | Publish each branch's app preview and run the same reset, edit, save, reload reproduction from a verifier browser outside the app sandbox. Disconnect that browser while an operation is running, then reconnect and recover the job state and outputs. | Preview URL/expiry receipt, browser assertions, screenshots, and traces. The job remains discoverable; persisted operation IDs, final status, output, and receipts match the run record. A screenshot alone does not establish the reproduction result, and a lost UI connection is not treated as a lost job without checking provider state. |
| 6. Cleanup and exported evidence | Export diffs, test output, traces, screenshots, and receipts; destroy completed sandboxes and revoke/expire their previews. | Destroy confirmations and preview unavailability are observed. Exported evidence remains readable outside the sandboxes. Record any resources or previews that remain. |
| 7. Interrupted request retry | After the normal operation path has succeeded, deliberately interrupt one checkpoint request after submission, then retry using the exact persisted idempotency key and request body. | The retry returns or recovers the original operation result and creates no duplicate checkpoint, sandbox, or branch. Preserve both attempts' receipts and raw responses. Never change the key or body for an uncertain retry. |
| 8. Comparable performance and cost | Repeat cold and reused preparation, branch creation, preview readiness, and resume measurements with matching resource, region, and workload settings. | Keep per-operation timestamps and receipts, CPU, RAM, disk, region, provider SDK/API versions, cache state, and cold/warm variant. Report actual provider compute, persistent storage, model inference, and idle capacity charges separately; record free credits and zero-charge cases. Do not infer cost from elapsed time or list prices. |

## Provider-specific distinctions

- **E2B:** Set an explicit timeout for fork operations; the documented default is 15 seconds. Record the source pause, active-stream disconnection, fork receipt, branch write checks, and any required reconnect. See [E2B sandbox fork](https://docs.e2b.dev/sandbox/fork) and [persistence](https://docs.e2b.dev/sandbox/persistence).
- **Daytona:** Run container filesystem snapshots that require a stopped source separately from VM snapshots that may preserve hot memory. Test volumes and warm pools as independent variants; do not combine their best outcomes in one result. Record sandbox class, capture mode, volume/cache state, pool eligibility and organization enablement. See [snapshots](https://www.daytona.io/docs/en/snapshots/#create-snapshot-from-sandbox), [volumes](https://www.daytona.io/docs/en/volumes/), and [warm pools](https://www.daytona.io/docs/en/warm-pools/).
- **MainBrella:** Inspect the deployment's advertised capabilities. A future native-fork mode must require `persistence.filesystemFork=true`, exercise `POST /containers/fork`, and record observed process behavior; filesystem support alone does not establish memory preservation. If it is unavailable, evaluate saved-workspace restore separately as a fresh-process path. Record the capability response and receipts for either path. See [container saved workspaces](https://mainbrella.com/docs/containers/#saved-workspaces).

## Receipt and result rules

Every implemented adapter mutation persists its exact request before submission and retains timestamps and raw evidence. Only operations with documented keyed idempotency send an idempotency key; preview issuance explicitly lacks that guarantee. Stop/resume, native fork, volumes and warm pools remain future acceptance experiments. Use explicit timeouts. Report unsupported capabilities and partial failures as outcomes, not as provider-wide failures or successes. Keep provider compute, persistent storage, model inference, and idle-resource cost as separate measured categories. Do not add fake adapters or synthetic provider results to the local experiment.
