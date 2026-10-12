# Mainbrella production lifecycle qualification — October 12, 2026

**Completed with an SDK finding.** The production filesystem lifecycle checks for
stop, resume and fork passed against `https://api.mainbrella.com`. The installed
JavaScript SDK reported one late stop replay as `stop_unconfirmed`; the raw API
returned HTTP 200 and left the resumed replacement running. The result is
`completed_with_sdk_findings`.

The run used API version `2026-10-11` and the clean installed, unpublished
JavaScript SDK candidate `0.2.0` (archive SHA-256
`23c735a2d831f273628d7e09e85a95a4ba75bf6c7c292c02fe643d2b1e58be02`, qualified
at `2026-10-12T13:45:07.561Z`). The API deployment was
`96f234b3-5065-4116-b47e-7875494f5164`; the runtime deployment was
`88bcb93d-3e88-41a3-b620-d03ae5aec63b`. The run lasted from
`2026-10-12T14:10:25.384Z` to `2026-10-12T14:11:48.957Z`.

The unchanged [sanitized result](../examples/mainbrella-cloud-lifecycle/result.json),
[checksum](../examples/mainbrella-cloud-lifecycle/result.sha256),
[independent post-run inventory](../examples/mainbrella-cloud-lifecycle/post-run-inventory.json),
and [evidence validation](../examples/mainbrella-cloud-lifecycle/evidence-validation.json)
are retained separately. Independent validation confirmed the sanitized result
checksum, all 89 sealed private file hashes and the authenticated account match.
The tracked runner is [src/lifecycle-experiment.ts](../src/lifecycle-experiment.ts);
its focused checks are in [tests/lifecycle-experiment.test.ts](../tests/lifecycle-experiment.test.ts).
The sealed evidence retains the exact runner input bytes used in production. A
later type-only portability edit removes the sibling-backend compile-time
dependency; both versions compile to identical runtime JavaScript. Type checking
and all four focused tests passed after that edit.
The private ignored evidence is retained under
`artifacts/mainbrella-lifecycle-2026-10-12T14-10-25-316Z/private/`.

## Observed outcomes

| Check | Outcome |
| --- | --- |
| Source and fork | The source stayed alive while the fork accepted independent writes. The binary file at a Unicode path was preserved in the fork. A successful fork response was deliberately discarded after HTTP headers and its body were retained privately; retry with the same key recovered the fork. This did not simulate response loss during capture. |
| Fork and resume processes | Both had fresh process nonces and reset heaps. The source reported PID 33 and heap marker 1; the fork PID 4 and resume PID 7 both reported heap marker 0. This supports filesystem persistence without RAM preservation. |
| Startup and replay | Fork and resume started automatically in the foreground. Replaying fork, resume and stop requests did not add starts, captures or relaunches. A changed fork body returned HTTP 409. |
| Stop and stale access | Stop retained the stopped container's slot and generation identity and referenced its saved workspace. Reads and deletes through stale identities were denied with HTTP 409. A late raw stop replay after resume kept the replacement running. |
| Resume filesystem | The binary file, Unicode path, permissions, modification time and symlink were preserved after resume. |
| SDK late stop replay | The installed SDK retried with the original key after resume and reported `stop_unconfirmed`, although the raw API returned HTTP 200 and preserved the replacement. This client finding remains unfixed. |
| Cleanup | All three exact container generations and both workspaces were removed. All three old previews returned HTTP 403. The original account inventory was preserved. |

The account used three Lite starts, from 130 to 133, and two captures, from 12
to 14. Independent authenticated post-run inventory confirmed starts at 133,
no containers and no workspaces, with the original account inventory preserved.
All three old previews again returned HTTP 403 during independent verification.
Each capture reserved 2 GB of disk, 4 GB total; live saved workspaces and
reserved bytes returned to zero after cleanup. Monthly and retained capture
budgets rose from 78 GB to 82 GB and remained at 82 GB after cleanup. No
entitlement or funding change was made. These are lifecycle observations, not a
performance or price comparison.

The 118 RepoRodeo tests and TypeScript check passed before the live run. An
earlier suite attempt overlapped a fixture-source edit and failed before any
paid starts; the frozen-source rerun passed. No full article-app repair suite
was rerun. The Python helper contains the same retry validation in source, but
the installed Python SDK was not live-tested. Dashboard UI, SSH, WebSockets,
egress controls and vault behavior remain outside this qualification; egress
and vault are disabled. API deletion confirms resource cleanup, not physical
snapshot erasure. This separate runner calls the lifecycle APIs through the SDK;
the Mainbrella adapter's `filesystem-fork` experiment mode remains unimplemented.

## Reproduction

The original run used a host-only `MAINBRELLA_API_KEY`, Node `22.22.2`, a clean
installed SDK `0.2.0`, and candidate provenance JSON containing its version,
archive SHA-256, qualification time and worker deployment IDs. A new run needs
a new output directory and an account with available capacity for three starts
and two full-disk captures:

```sh
node src/lifecycle-experiment.ts \
  --output artifacts/my-new-lifecycle-run \
  --sdk-module /path/to/clean-installed-sdk/index.js \
  --candidate-source /path/to/candidate-source.json
```

The spent qualification budget should not be treated as available for another
run.
