# Local run record

[`run-result.json`](run-result.json) is an unchanged manifest from a real local run with seed `0`. The baseline and misleading patch each produced five verified missing-block failures and one passing reset check; the correct patch passed all six tests. No provider or AI agent participated.

This is a schema example and a retained summary. The companion logs, traces, screenshots, patches, and input snapshot are generated under `artifacts/` and excluded from Git. Run `npm run experiment -- --seed 0` to create a complete bundle on your machine. Paths inside a manifest are relative to its bundle root; attachment paths inside each portable `report.json` are relative to that report. `report.raw.json` retains Playwright's original output.

The recorded source was an uncommitted working tree. `sourceCommit` identifies its base revision, while `source.dirty`, `source.inputHashes`, the archived `inputs/`, and per-control app hashes identify the code actually tested. The base SHA alone does not describe these changes. Manifest checksums detect accidental changes; they are not signatures or independent attestations.
