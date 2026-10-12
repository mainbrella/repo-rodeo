# Volatile worker repair control

This deliberately small fixture tests whether a copied process can retain a
repair reproduction that a fresh process loses. It is not an agent benchmark.

The outside verifier sends five jobs once to a running worker. The jobs remain
in its JavaScript heap at a paused checkpoint; the worker never logs or writes
them to disk. Two jobs have zero unit price. The baseline processor drops these
jobs through a truthiness filter, producing three receipts. A correct supplied
patch produces all five exactly once. A misleading supplied patch claims
completion while returning none. The verifier owns the expected IDs and values
outside every sandbox and rejects missing, extra, duplicate or wrong receipts.

The worker imports `processor.mjs` when `/resume` is called. Changing that file
therefore does not require restarting the process. This explicit reload point
is part of the experiment, not a claim of transparent hot replacement of an
already executing function. A successful repair must also preserve the paused
preparation ID, input fingerprint, nonce and PID.

Run the local fixture and verifier checks with Node 22.22.2:

```sh
npm ci
node --test tests/worker-experiment.test.ts
```

Local checks exercise each deterministic patch, the cold restart control and
verifier adversaries. They do not emulate a cloud memory fork. Cloud runs use
the existing provider adapters, create one source plus three branches, and
delete only the exact run-owned resources:

```sh
node src/worker-experiment.ts --provider e2b --seed 12345 --output artifacts/worker-e2b-1
node src/worker-experiment.ts --provider mainbrella --seed 12345 --output artifacts/worker-mainbrella-1
node src/worker-experiment.ts --provider daytona --seed 12345 --output artifacts/worker-daytona-1
```

Set the corresponding `E2B_API_KEY`, `MAINBRELLA_API_KEY` or `DAYTONA_API_KEY`
in the host environment. Mainbrella defaults to its production API. The
experiment uses E2B native memory fork, Mainbrella saved filesystem workspace,
and Daytona stopped-container filesystem snapshot. No queue is re-enqueued or
read back from a host ledger into a branch. A filesystem restore must start a
new, empty worker: the result is `reproduction-lost`, never a successful fix or
a claim that filesystem snapshots are defective. After branch checks, the
source is explicitly restarted and the correct patch run against its now-empty
queue as an additional loss control.

`result.json` and named observation JSON files are public evidence. `private/`
contains credentials or bearer preview URLs in provider responses and must not
be shared. Input SHA-256 hashes identify exact dirty-tree source bytes; the
result also records Git commit and dirty status. `result.sha256` preserves the
final result. Cleanup confirms API absence, not physical storage erasure or
standalone preview credential invalidation. The worker experiment does not
issue a verdict on those separate preview properties.
