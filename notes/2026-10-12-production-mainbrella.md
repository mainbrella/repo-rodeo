# Production Mainbrella qualification — October 12, 2026

**Completed.** The tracked runner passed the saved-workspace experiment against
`https://api.mainbrella.com`, using `MAINBRELLA_API_KEY` from the host's ignored
`../backend/.env`. The file was parsed without sourcing it; only that key was
used, and neither the key nor the environment file was uploaded or passed to
the verifier browser.

The workload is the full MainBrella web checkout at
`3eb5f1d144324793492bed765d94bc6463614ef3`, seed `12345`, matching the E2B and
Daytona cloud workloads. The implementation was the clean repository commit
`1c6f044a457f28edbcbdd295c91eafec7a0298df`. No adapter changes were needed.
The host's newer web checkout and the backend checkout remained untouched.

The run lasted from `2026-10-12T09:16:42.489Z` to
`2026-10-12T09:20:05.786Z` (2:16–2:20 AM PDT). Private evidence remains in
`artifacts/mainbrella-production-2026-10-12T09-16-42-487Z/run/`.
The unchanged [sanitized result](../examples/mainbrella-cloud-saved-workspace/result.json),
[checksum](../examples/mainbrella-cloud-saved-workspace/result.sha256), and
24 allowlisted document observations are retained separately from raw reports,
screenshots, traces, request journals and bearer preview URLs.

## Capability and preparation

Production advertised API version `2026-10-11`, saved workspaces, snapshots,
protected previews, managed executions and reconnection. Native filesystem forks
and memory preservation were unavailable, so this run used the explicit
`saved-workspace` mode with fresh processes in each restore.

Quota preflight passed before provisioning. The account initially had one existing
container and no saved workspaces. The test requested Small: 0.5 vCPU, 4,096 MiB
memory and 8 GB disk. Those are catalog allocations; resource enforcement was
not measured. No account entitlement or funding fixture was created.

Tracked source was archived, uploaded and extracted in one source container.
`npm ci --no-audit --no-fund` and the guest web type check passed. Guest Node/npm
were `24.21.0`/`11.19.0`; the external verifier used host Node `22.22.2`,
Playwright `1.63.0` and Chromium `153.0.8010.12`. E2B and Daytona used different
guest runtime versions and resource allocations, so these runs do not establish
comparable performance or price.

## Observed outcomes

| Check | Outcome |
| --- | --- |
| Prepared external browser baseline | Five exact first-block-loss failures; reset isolation passed |
| Saved-workspace capture | One workspace captured with `stop:false`; source nonce and PID survived |
| Three restores | Source hashes, dependency lockfile, prepared marker, permissions and symlink preserved without another install |
| Process semantics | No inherited listener in any restore; explicit launches produced three distinct fresh nonces |
| Restored baseline | Five expected failures and one passing reset check; reproduced |
| Correct repair | All six browser checks passed, including 12 holdout reloads |
| Misleading repair | The same five expected failures and passing reset check; reproduced |
| Final isolation | Each branch retained its expected patched hashes and distinct marker; source remained unchanged |
| Capture replay | First successful response body discarded after HTTP headers; identical keyed retry and replay returned one workspace with one reservation |
| Job reconnection | SSE client disconnected after initial output; a new client recovered the same execution ID, exit 0 and remaining output from its cursor |
| Host input integrity | Final comparison passed; all 47 retained input files match the runner commit |
| Cleanup | Four exact container generations and the workspace absent; all four old bearer previews returned HTTP 404 |

The response-loss check establishes recovery after successful response headers.
It does not test a disconnect before admission or during snapshot capture.
Job reconnection exercises API clients; production login and dashboard browser
session reconnection were outside this run. Repairs were deterministic patches.

## Cleanup, accounting and evidence

The [independent post-run inventory](../examples/mainbrella-cloud-saved-workspace/post-run-inventory.json)
used GET requests only and verified the same authenticated account. At
`2026-10-12T09:21:09.894Z`, all four owned generations and the exact workspace
were absent. The original container was preserved, and saved-workspace inventory
was empty. Four further probes of the old previews also returned HTTP 404.

The API reported a capture size of **258,985,091 bytes**. Capture reserved the
full **8,000,000,000-byte** requested disk against live workspace and capture
budgets. Deletion released live reservations to zero. Monthly saves increased
from 3 to 4; monthly captured and retained-capture counters each increased from
6 GB to 14 GB and remained there after cleanup. Those accounting counters do not
measure unique physical storage. Physical snapshot reclamation and actual charges
remain unmeasured. The approximately 203-second elapsed time is one qualification
run, not a comparative benchmark.

The [independent evidence validation](../examples/mainbrella-cloud-saved-workspace/evidence-validation.json)
rechecked the result checksum, all 1,593 sealed private file hashes, 24 public
observation hashes, 47 retained input hashes against the runner commit, and all
four browser reports with the strict verifier. Public exports were scanned for
the actual API key and bearer preview credentials before retention.
All 103 repository tests and TypeScript checking passed before the production run.
Historical local, E2B and Daytona evidence was preserved.

## Reproduction

With `MAINBRELLA_API_KEY` available only in the host environment:

```sh
npm run experiment -- --provider mainbrella --mode saved-workspace \
  --api-url https://api.mainbrella.com \
  --source ../web --source-ref 3eb5f1d144324793492bed765d94bc6463614ef3 \
  --seed 12345 --check-idempotency
```

Use a new output directory and an account with available quotas. Native forks,
memory preservation, volumes, warm pools, physical retention, AI repair agents
and matched provider cost/performance experiments remain separate work.
