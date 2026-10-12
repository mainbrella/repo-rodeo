# Run records

New [matched editor and cleanup follow-ups](../notes/2026-10-12-matched-followup.md) use identical probes and interpretation for all providers. Their results separate repair controls, API resource deletion, preview HTTP observations, independent token invalidation and physical storage. Historical bundles below retain their original bytes and classifications; those old completion labels are not an overall provider ranking.

[`mainbrella-cloud-saved-workspace/result.json`](mainbrella-cloud-saved-workspace/result.json)
retains the completed production MainBrella run against `api.mainbrella.com`, web
revision `3eb5f1d`, and seed `12345`. One saved workspace supplied three fresh
process restores. Baseline and misleading controls reproduced first-block loss;
the correct repair passed all six checks. Filesystem preservation, isolation,
capture replay after successful response headers, API job reconnection and cleanup
passed. The unchanged result, checksum and 24 allowlisted observations include the
prepared baseline. Independent evidence validation and post-run inventory confirm
the retained hashes, exact owned-resource absence, preserved existing container
and four HTTP 404 previews. Physical storage and charges remain unmeasured.
See the [production notes](../notes/2026-10-12-production-mainbrella.md).

[`run-result.json`](run-result.json) is an unchanged manifest from a real local run with seed `0`. The baseline and misleading patch each produced five verified missing-block failures and one passing reset check; the correct patch passed all six tests. No provider or AI agent participated.

This is a schema example and a retained summary. The companion logs, traces, screenshots, patches, and input snapshot are generated under `artifacts/` and excluded from Git. Run `npm run experiment -- --seed 0` to create a complete bundle on your machine. Paths inside a manifest are relative to its bundle root; attachment paths inside each portable `report.json` are relative to that report. `report.raw.json` retains Playwright's original output.

The recorded source was an uncommitted working tree. `sourceCommit` identifies its base revision, while `source.dirty`, `source.inputHashes`, the archived `inputs/`, and per-control app hashes identify the code actually tested. The base SHA alone does not describe these changes. Manifest checksums detect accidental changes; they are not signatures or independent attestations.

[`mainbrella-preflight-result.json`](mainbrella-preflight-result.json) is a real
version-2 result from the tracked adapter against the local API. It failed before
provisioning: the account had 100 saved workspaces against a limit of 20, and its
monthly save count was also exhausted. Its private request journal contains only
GET requests for capabilities and inventories. Before/after accounting is
unchanged; no container or workspace was created or deleted. This qualifies the
preflight failure path, not the new adapter's full restore experiment. The raw
journal remains in `artifacts/mainbrella-adapter-preflight-v2/private/`. A cleanup
retry preserved the original result and its sealed evidence checksums.

[`e2b-cloud-memory-fork/result.json`](e2b-cloud-memory-fork/result.json) is the
completed real E2B cloud qualification against web revision `3eb5f1d`, with seed
`12345`. One native fork produced three branches that inherited the running server's
PID and nonce. Baseline and misleading controls reproduced first-block loss; the
correct patch passed all six checks. Filesystem preservation, final isolation,
command reconnection, host input integrity and cleanup passed. E2B keyed replay
remains unsupported; performance and cost remain unmeasured.

The result, checksum and 18 allowlisted observations are copied unchanged from the
private run. Supplemental validation confirms all input bytes match the pinned
local implementation commit despite the retained dirty-worktree marker. Independent
post-run inventory and repeated deletion probes confirm exact sandbox absence and
HTTP 502 responses with and without retained traffic tokens. The historical rule accepted these; new matched runs classify them as gateway unavailability and leave the preview access transition inconclusive. They do not prove separately revoked tokens. The original
[`e2b-cloud-preview-failure/result.json`](e2b-cloud-preview-failure/result.json)
remains unchanged; its unchecked `source.integrity: false` is a historical reporting
defect, corrected to `null` in new early-failure results. See the
[run notes](../notes/2026-10-11-e2b.md) for scope and provenance.

[`daytona-cloud-snapshot-timeout/result.json`](daytona-cloud-snapshot-timeout/result.json)
retains the original failed capture unchanged. Its empty controls and unchecked
`source.integrity: false` do not negate the verified prepared browser baseline.
The separate [baseline reverification](daytona-cloud-snapshot-timeout/prepared-baseline-reverification.json)
checks the sealed private evidence and confirms five expected failures and one
passing reset test; six allowlisted documents are in `recovered-observations/`.
The [read-only inventory reconciliation](daytona-cloud-snapshot-timeout/review-inventory-reconciliation.json)
records both retained resource IDs absent at `2026-10-12T03:45:10.174Z` with the
original credential. It also checks the exact snapshot name and sandbox run label.
No provider mutation was issued. This observation leaves the original uncertain
capture, automatic cleanup confirmation, preview revocation, and physical storage
claims unchanged. See the [Daytona notes](../notes/2026-10-11-daytona.md).

[`daytona-cloud-snapshot-rerun/result.json`](daytona-cloud-snapshot-rerun/result.json)
records the October 12 rerun with the required sandbox and snapshot scopes. One
capture supplied three restores; the controls, isolation, input integrity and
API cleanup passed, and all exact run resources were independently confirmed
absent. The result remains failed because some deleted-sandbox preview URLs
returned 401 instead of the required 404/410. See the
[rerun notes](../notes/2026-10-12-daytona-rerun.md); the earlier result remains
unchanged.
