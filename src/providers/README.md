# Provider acceptance plan

**Status: MainBrella production saved-workspace and E2B native memory-fork cloud qualification complete; full Daytona qualification pending.** The [production MainBrella run](../../notes/2026-10-12-production-mainbrella.md) verifies the tracked capture/restore workflow, deterministic controls, isolation, capture replay, API job reconnection and cleanup against `api.mainbrella.com`. The [manual local run](../../notes/2026-10-11-local-mainbrella.md) exercises the local API and OrbStack containers; its historical harness does not qualify the tracked local adapter. The [E2B cloud notes](../../notes/2026-10-11-e2b.md) preserve the original browser failure and the successful pinned three-branch memory-fork, repair, reconnection and cleanup run. Other modes remain unqualified. The [Daytona cloud notes](../../notes/2026-10-11-daytona.md) record a protected browser baseline and the snapshot qualification attempt. Matched production comparison runs remain planned.

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

All three provider selections emit [`ExperimentResult` schema version 2](../experiment-result.ts). MainBrella and Daytona implement `saved-workspace`; E2B implements `memory-fork` and the separate filesystem-only snapshot `saved-workspace` path. Other modes retain distinct names and report `unsupported` or `not-implemented`; the runner does not silently substitute a restore. The default standalone `--provider local` runner retains its original version-1 manifest.

New results identify the implementation with `runner.commit` and `runner.dirty`,
separately from the application's `source.commit`. Retained input hashes identify
the actual experiment files. `source.integrity` is `null` until the final host-input
comparison runs, then `true` or `false`. Historical results retain their original
bytes; an early failure's old `false` value does not prove an integrity failure.
New results also retain `preparedBaseline` as soon as the external verifier
returns, including an unverified outcome. Its allowlisted observations are exported
under `observations/prepared-baseline/`, even when capture fails before any control.

For E2B, set `E2B_API_KEY` and run `npm run experiment -- --provider e2b --seed 12345`.
It defaults to the `base` template, `memory-fork`, and the official cloud API.
One fork call requests three branches with 30-minute lifetimes. The runner checks
their inherited listener, nonce and PID, then stops each copied server and launches
a new one for patch verification. Protected HTTP/browser requests use a traffic
token restricted to that preview origin. Same-origin redirects are bounded.
Guest Node is checksum-verified and pinned before preparation; the verifier stays
outside every guest.

E2B cleanup requires confirmed API absence of every preview's exact sandbox and
three probes, spaced two seconds apart, with and without its retained traffic token.
HTTP 404/410/502 qualifies as denied application access only with that API evidence.
Repeated probes of the first deleted cloud sandbox returned 502 in both cases;
this is an observed gateway response, not a documented token-revocation guarantee.
Network failures and other responses remain inconclusive. MainBrella and Daytona
retain their HTTP 404/410 rule. Run cleanup and later reconciliation use the same
acceptance logic.

E2B mutation retries are disabled because there is no documented keyed replay
contract. `--check-idempotency` reports unsupported and never injects/replays a lost
mutation. A completed local operation journal may return its retained result;
that is not provider idempotency evidence. Ambiguous provisioning remains
unconfirmed even after cleanup removes discovered run-tagged resources. Recovery
requires the exact authenticated key fingerprint; rotated-key recovery is not
supported because the API-key interface does not expose team identity. Workspace
reservation counters, capture bytes, resource limits and prices are not invented
when absent from the API. Its command reconnection uses the SDK PID and durable
guest stdout with a byte offset, not a server SSE cursor.

For Daytona, set `DAYTONA_API_KEY` and run `npm run experiment -- --provider daytona
--seed 12345`. It defaults to `saved-workspace`, the official cloud API at
`https://app.daytona.io/api`, and the default container snapshot (`--size default`).
Before provisioning, a read-only `/api-keys/current` lookup requires all four
scopes: `write:sandboxes`, `delete:sandboxes`, `write:snapshots`, and
`delete:snapshots`. Missing, malformed, or unavailable permission metadata fails
closed. Only scopes are retained; the API key value in the response is discarded.
Cleanup uses the existing credential binding without requiring provisioning scopes.
The guest pins Node before preparation and uses the default image's passwordless
sudo for `/opt` and `/workspace`; binary uploads are staged in `/tmp` first.
Capture explicitly stops the source, creates one persistent filesystem snapshot,
and restarts the source container. The runner verifies that the source and each
restored branch have no inherited listener, then launches fresh servers. Captures
allow ten minutes; wall-clock TTLs bound sandbox retention to 30 minutes. Immediate
auto-delete is disabled so stopping the source does not destroy it before capture.
Capture journals the exact snapshot name before submission, submits one REST
request, and independently polls that name. Durable lifecycle records distinguish
submission acknowledgement from snapshot readiness and source restart. A lost
submission response can be resolved by observing that exact snapshot become active
within the capture deadline. An expired capture stays uncertain; later cleanup
observations are separate and never replay submission or overwrite that outcome.

[Container forks are unsupported](https://www.daytona.io/docs/en/sandboxes/#fork-sandboxes).
VM memory forks, volumes and warm pools remain separate, unimplemented modes.
Standard preview tokens use `x-daytona-preview-token` and are sandbox-wide
credentials; they stay private and are scoped to the preview origin in host and
browser requests. Stopping a sandbox rotates its token; deletion revokes access.
The adapter confirms private access with HTTP 401/403 denial and retains the
strict HTTP 404/410 post-deletion check alongside exact API sandbox absence.
After source restart, `previewTokenInvalidation` compares the retained and fresh
tokens at the same URL: the retained token must return HTTP 401/403 while the
fresh token returns HTTP 200. HTTP 400 remains inconclusive. Sandbox absence and
snapshot absence remain separate entries in `cleanup`; snapshot observations
include their state and timestamp independently of the original journal outcome.
Session reattachment recovers the same
session/command IDs and retained stdout with a byte offset; it does not exercise
live stream disconnection or dashboard reconnection. Guest `timeout` bounds each
asynchronous command's runtime.

Daytona has no documented keyed mutation replay contract. Journals persist logical
SDK inputs, ownership, durable uploads and sanitized receipts before submission;
unknown admissions are never replayed. The pinned SDK retries non-idempotent
requests only after a provable pre-submission connection failure. Cleanup discovers
uncertain resources using exact journaled names, deletes only this run's resources,
and polls inventory for deletion propagation. An ambiguous provisioning/capture
operation still prevents full cleanup confirmation even if discovered resources
are absent. Recovery pins the exact original key fingerprint; rotated-key recovery
is not implemented. Capacity counters, capture byte accounting and price remain
unavailable through this adapter and are reported as such.

- Exit 0: expected controls, implemented lifecycle checks, input integrity and API cleanup confirmed.
- Exit 1: a failed or unverified operation, check or cleanup; partial evidence is retained.
- Exit 2: the chosen adapter or experiment mode is unavailable.

Each new output directory contains `result.json`, `result.sha256`, `observations/`, and `private/`. Only the first three are intended for sharing. Observation export allowlists document fields, omits arbitrary metadata, and redacts URLs/credentials. Those observations supplement the result; re-running the strict verifier also requires private trace/screenshot artifacts. `private/` contains the exact inputs, archive, patches, before/after observations, browser results, request journals, each response attempt, and ownership records. Its request/response files have private permissions; provider API credentials are not journaled or uploaded. Protected preview URLs are bearer credentials and remain private.

MainBrella operations persist a stable name, generated idempotency key, exact
HTTP body, and timestamps before network submission. Retries preserve the body
and key. Its preview issuance is not idempotent and is never blindly replayed.
Cleanup also handles unknown preview issuance by destroying its owned generation.
E2B journals preserve logical SDK inputs and receipts, not raw protocol bodies or
credentials; its unknown mutations are never replayed. Upload payloads become
durable before a journal can reference them.

Before the result is finalized, the current journal is copied into
`private/journal-snapshot/`. The result hashes that snapshot and the retained
inputs/artifacts; it excludes the live `operations/`, `owned/`, and `receipts/`
directories that recovery may extend. Cleanup retries preserve the original
checksummed evidence.

```sh
npm run experiment -- --cleanup artifacts/<run-directory>
```

MainBrella persists the authenticated account ID and API origin before any provider
request journal. Cleanup verifies it before replay, deletion, or inventory
confirmation; another account is rejected and rotated keys for the original account
are accepted. Old runs without that binding are not automatically adopted.
Recovery replays unresolved create/capture requests only within their retention
window and removes exact recorded generations/workspace IDs. Generation reuse cannot
authorize deletion of a replacement. E2B and Daytona use the stricter exact-key binding above
and never reissues uncertain mutations. Corrupt journals or inconclusive inventory
leave cleanup unconfirmed. The original result is immutable; recovery writes a
separate timestamped report. Catchable signals enter cleanup; after a hard kill,
use this command with the appropriate provider key.

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

Every implemented adapter mutation records its inputs before submission and
retains timestamps and evidence. MainBrella retains exact HTTP bodies; E2B records
SDK inputs. Only operations with documented keyed idempotency send an idempotency
key. E2B native fork is implemented but remains live unqualified; MainBrella native
fork, pause/resume, volumes, and warm pools remain future acceptance experiments.
Use explicit timeouts. Report unsupported capabilities and partial failures as
outcomes, not as provider-wide failures or successes. Keep provider compute,
persistent storage, model inference, and idle-resource cost as separate measured
categories. Do not add fake adapters or synthetic provider results to the local experiment.
