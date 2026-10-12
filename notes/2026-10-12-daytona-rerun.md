# Daytona snapshot rerun — October 12, 2026

The rerun resolved the snapshot permission and deletion problem. Full Daytona
qualification remains pending because strict post-delete preview revocation was
not confirmed: the contract requires HTTP 404/410 after exact API absence, while
some preview URLs returned 401. The original failed capture result and its
checksums remain unchanged.

## Run and evidence

- Public sanitized bundle: [`result.json`](../examples/daytona-cloud-snapshot-rerun/result.json),
  [`result.sha256`](../examples/daytona-cloud-snapshot-rerun/result.sha256),
  24 [allowlisted observations](../examples/daytona-cloud-snapshot-rerun/observations/),
  [preflight](../examples/daytona-cloud-snapshot-rerun/preflight.json),
  [post-run inventory](../examples/daytona-cloud-snapshot-rerun/post-run-inventory.json),
  and [independent evidence validation](../examples/daytona-cloud-snapshot-rerun/evidence-validation.json).
- Run `daytona-2026-10-12T09-49-17-236Z-53310c71`; started at
  `2026-10-12T09:49:17.236Z`, finished at `2026-10-12T09:53:15.562Z`.
- Clean runner commit `2c0b5f9a879fc199e4c9db78ea6e0832e572f057`; web source
  revision `3eb5f1d144324793492bed765d94bc6463614ef3`; seed `12345`;
  `@daytona/sdk` `0.223.1`.
- Host and guest used Node `22.22.2` and npm `10.9.7`. The external verifier used
  Playwright `1.63.0` and Chromium `153.0.8010.12`. The API reported 1 vCPU,
  1 GiB memory and 3 GiB disk; these
  are allocations, not measured enforcement. Billing and physical storage were
  not measured.
- The full-access credential had a different fingerprint from the historical
  key. Preflight confirmed all four required sandbox/snapshot write/delete
  scopes. Read-only lookups for the prior sandbox and snapshot both returned 404.

## Results

One snapshot capture ran from `2026-10-12T09:50:10.558Z` to
`2026-10-12T09:50:44.549Z` (34 seconds) and supplied three restores. The source
was stopped and restarted; fresh servers were launched after capture. A retained
preview token returned 401 while a fresh token returned 200 at the same URL.
The prepared baseline, restored baseline and misleading repair each reproduced
five first-block-loss failures, with reset isolation passing; the correct repair
passed all six checks.
Filesystem preservation, installed dependencies, fresh processes, branch
isolation, session stdout recovery, and final input integrity were verified.
Keyed mutation replay remains unsupported and was not attempted.

All four exact run-owned sandboxes and snapshot
`9190ccb3-0822-4469-9bc0-e12fafad44ce` were deleted. Cleanup reported confirmed
with no errors. Independent GET-only inventory remained at zero sandboxes and
13 snapshots before and after, preserved every original snapshot ID, and returned
404 for each exact run resource. This resolves the prior snapshot permission and
deletion issue.

Preview revocation is the sole failed check. Immediately after deletion, the five
preview statuses were `401, 401, 401, 404, 404`; later authenticated probes were
`401, 401, 401, 401, 404`, while unauthenticated probes all returned 401. Since
the strict contract accepts only 404/410 after API-confirmed sandbox absence,
these 401 responses do not establish the required revocation result. The overall
run therefore remains **failed**, and full Daytona qualification remains
pending. This does not weaken the acceptance rule.

Independent validation checked 1,552 sealed evidence hashes, all 24 public
observations, 47 source input hashes against the archive and runner commit, and
four controls. The public credential/preview-secret scan passed. Before the run,
all 103 repository tests and `npm run typecheck` passed; no code changed. The
prior historical result and checksums were left intact.
