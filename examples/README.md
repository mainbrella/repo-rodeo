# Local run record

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
