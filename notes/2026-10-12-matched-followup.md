# Matched editor and cleanup follow-up — October 12, 2026

The follow-up replaces provider-specific preview acceptance rules for new runs.
It does not rewrite the historical results. An HTTP 401 response means access was
denied; an HTTP 502 response means the gateway was unavailable. Neither proves
that a credential was independently revoked, and neither is a provider ranking.

## Shared protocol

Each run uses web revision `3eb5f1d144324793492bed765d94bc6463614ef3`, seed
`12345`, the same lockfile and deterministic patches, Node `22.22.2`, and the
external Playwright `1.63.0` verifier. The selected modes remain MainBrella saved
workspaces, E2B memory forks and Daytona container filesystem snapshots. Resource
allocations differ; these are semantic and correctness checks, not performance
or cost comparisons.

The prepared source must reproduce the failure. One capture supplies baseline,
correct and misleading branches. The unchanged six-test verifier runs outside the
guests. The source and branches are checked for tracked files, dependencies,
permissions, symlinks, listener/PID/nonce preservation and independent writes.
E2B's inherited editor servers are still explicitly restarted before applying
these browser-storage repairs; this fixture alone does not show a repair benefit
from memory preservation.

The common recovery workload prints a start marker, waits eight seconds, and
prints a completion marker. After initial output the first client detaches. A
new client must recover the same command identity, exit code zero, both markers,
and the remaining output from a saved position. API SSE cursor replay, SDK
command reconnection and session polling are different mechanisms and remain
identified in each result. Dashboard reconnection is not tested. Keyed capture
replay is disabled for all three matched runs; MainBrella's separate historical
response-loss test remains a narrower demonstrated capability.

Before deletion, the current credential at every preview URL must return HTTP
200. Superseded Daytona tokens are retained in private evidence and assessed in
a separate restart-token check; the latest token is used in the matched cleanup
check. Each issued preview is revoked where the adapter supports it, then the
four exact sandbox generations and capture resources are cleaned up.

All providers receive three probes per retained URL, spaced two seconds apart,
with and without preview headers. E2B and Daytona put their preview credential in a header, so the second request removes it. MainBrella uses a bearer hostname: both requests retain that credential and are repeated probes of the same retained URL. An unauthenticated request to that same URL is not available. The same HTTP interpretation applies:

| HTTP observation | Meaning |
| --- | --- |
| 200–299 | HTTP access still succeeds; cleanup access check fails |
| 401/403 | Access denied |
| 404/410 | Route absent |
| 502/503/504 | Gateway unavailable; access transition inconclusive |
| Network error or other status | Inconclusive |

Exact API resource absence is checked independently. No HTTP response proves
physical snapshot deletion. Snapshot absence and independent credential
invalidation are separate claims. An inconclusive preview observation does not
turn completed repair controls and confirmed API deletion into a provider-wide
failure.

A second adapter with a separate ownership journal provisions one small HTTP
server after the editor resources have been deleted. This keeps peak use to four
editor sandboxes rather than adding a fifth. Its known-live preview must return
200 before and during each of three additional matched rounds against the old
URLs. It is then deleted through its own journal. This control can detect a
broader gateway outage; it still cannot turn an old URL's 502 into proof of token
revocation.

Separate inventory reads before the editor run and after all cleanup require
exactly the original sandbox generations and capture IDs. Every pre-existing
resource is preserved. No account entitlements, quotas, templates or unrelated
resources are modified.

## Results and inspectable evidence

- [MainBrella editor result](../examples/mainbrella-matched-followup/result.json),
  [matched cleanup observations](../examples/mainbrella-matched-followup/preview-observations.json),
  [hash validation](../examples/mainbrella-matched-followup/evidence-validation.json).
- [E2B editor result](../examples/e2b-matched-followup/result.json),
  [matched cleanup observations](../examples/e2b-matched-followup/preview-observations.json),
  [hash validation](../examples/e2b-matched-followup/evidence-validation.json).
- [Daytona editor result](../examples/daytona-matched-followup/result.json),
  [matched cleanup observations](../examples/daytona-matched-followup/preview-observations.json),
  [hash validation](../examples/daytona-matched-followup/evidence-validation.json).

All three completed the expected baseline/correct/misleading outcomes,
filesystem and isolation checks, and new-client command recovery. Every current
preview returned 200 with its credential before cleanup.

| Provider | After cleanup, with credential | Without preview headers | API inventory |
| --- | --- | --- | --- |
| MainBrella | 404 at all four URLs, all three rounds | 404; bearer hostname still present | Original empty inventory restored |
| E2B | 502 at all four URLs, all three rounds | 502, token removed | Original empty inventory restored |
| Daytona | Source: 401; three branches: 404, all three rounds | 401 at all four URLs, token removed | All 13 original snapshots preserved; zero sandboxes |

All three known-live controls stayed at 200. Every exact run resource and control
was confirmed absent. The E2B preview access transition remains **inconclusive**,
while API deletion is confirmed. None establishes independent token invalidation
after deletion. Daytona separately verified source-restart token rotation: the
retained token returned 401 while its replacement returned 200 at the same live
URL.

The immutable raw `followup.json` records used the field name `unauthenticated`
for requests without headers. That name is inaccurate for MainBrella
bearer-hostname previews. The linked `preview-observations.json` files append an
explicit credential-transport clarification, preserve every observed status,
and bind to the original follow-up SHA-256. New runner output uses
`withoutPreviewHeaders` and records credential transport directly. The raw
records and checksums have not been rewritten.

## Source provenance and limits

The runner was frozen in an isolated checkout before provisioning so concurrent
article and fixture edits could not change its inputs. It ran from base commit
`99f25ce` with the protocol changes retained in this
[patch and source manifest](evidence/matched-protocol-20261012/manifest.json).
The manifest's separate `matched-followup.ts` file is added under `src/`; the
patch changes the existing runner. Each result identifies the full base commit,
48 exact input hashes and a dirty working tree. These are working-tree experiment
results, not falsely attributed to an unchanged commit.

For the MainBrella run, independent local validation checked 1,594 sealed private
files; for E2B, 1,524; for Daytona, 1,812. It also checked all 24 allowlisted
browser observations and
48 retained input hashes per run, both result/follow-up checksums, and absence of
retained preview URLs and tokens in the public export. The public observations
make document contents inspectable but cannot independently replay the strict
verification without the private browser traces and screenshots.

Before provisioning, type checking and 106 repository tests passed. After
clarifying bearer-URL transport, all 21 relevant preview and provider-runner
tests passed, including a focused test that verified that API-confirmed cleanup
with HTTP 502 leaves
the preview check inconclusive while preserving completed repair controls. No
billing or physical storage reclamation was measured.

Run the same follow-up with an environment credential and a new output directory:

```sh
node src/matched-followup.ts --provider e2b \
  --output artifacts/new-matched-run \
  --source ../web --source-ref 3eb5f1d144324793492bed765d94bc6463614ef3
```
