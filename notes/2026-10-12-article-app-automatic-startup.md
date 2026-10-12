# Article application: automatic startup follow-up — October 12, 2026

**Completed against production.** This separate qualification restores the
article's original 417-file web application three times with a saved foreground
launch recipe. All three copies became application-ready, answered the protected
app preview with HTTP 200, and had a fresh process nonce without a client-side
branch launch. This does not replace the original matched repair runs or their
initial-listener observations.

The [runner](../src/app-restore-launch-experiment.ts) archived web commit
`3eb5f1d144324793492bed765d94bc6463614ef3`, installed dependencies once, and passed
the guest type check before capturing. The saved recipe was:

```json
{
  "command": "VITE_API_URL=https://api.mainbrella.com node rodeo-server.mjs web-checkout",
  "cwd": "/workspace/rodeo",
  "readiness": { "port": 5173, "path": "/__rodeo_process", "timeoutMs": 30000 }
}
```

The run lasted from `2026-10-12T13:21:44.261Z` to
`2026-10-12T13:23:32.046Z`. Its immutable private evidence directory is
`artifacts/mainbrella-app-restore-launch-2026-10-12T13-21-44-060Z/`.
The result SHA-256 is
`18725ffd12116cc035adb6b3eaabb1eb98583a6aae94a4a4856ac489575d1d52`.
The final runner input SHA-256 is
`8be85b5429047e5b60b986d37db1f5d781b0fd28dac3d99910eef9bab5ea205e`.
The record seals 1,387 private files, including exact inputs and API journals.

| Observation | Source | Copy 1 | Copy 2 | Copy 3 |
| --- | --- | --- | --- | --- |
| Listener responding | Yes | Yes | Yes | Yes |
| PID | 134 | 14 | 14 | 15 |
| Nonce prefix | `978f34be` | `56795b22` | `69d975c3` | `49c7f7b7` |
| Source files matching | 417/417 | 417/417 | 417/417 | 417/417 |
| Client-side branch launch commands | n/a | 0 | 0 | 0 |
| Outside app preview | Not measured | HTTP 200 | HTTP 200 | HTTP 200 |

Each outside preview passed on its first request to the canonical
`/repo-rodeo-bug/` route. The service readiness report and direct guest HTTP probe
both confirmed the listener. The installed dependency lockfile, prepared marker,
permissions, and symlink also matched. Source PID and nonce remained unchanged
through capture and all three restores. Guest Node/npm were `24.21.0`/`11.19.0`;
the host used Node `22.22.2`.

API cleanup confirmed absence of all four exact owned container generations and
the saved workspace. Pre-existing container and workspace inventory was unchanged.
All 114 repository tests and TypeScript checking passed on the final runner source.
Credentials were read from the ignored backend environment file using Node's
parser, never sourced as shell code, printed, or uploaded. Raw bearer preview
URLs remain private.

## Retained unsuccessful attempts

Two earlier attempts remain immutable:

- `artifacts/mainbrella-app-restore-launch-2026-10-12T13-17-13-044Z/`
- `artifacts/mainbrella-app-restore-launch-2026-10-12T13-19-16-255Z/`

Both created one copy that was automatically ready and listening with all 417
files and a fresh nonce, then failed at the new runner's outside preview check.
Both cleaned their two owned generations and workspace completely. The first
record contains one `fetch failed` observation; the second records five failed
read-only requests. They were initially suspected to be transport failures.

The verifier requested the slashless `/repo-rodeo-bug` route with
`redirect: "error"`. Vite redirects that directory route to
`/repo-rodeo-bug/`. A local Vite check reproduced HTTP 308 on the slashless path,
HTTP 200 on the canonical path, and Node's `fetch failed` / `unexpected redirect`
error under the original policy. The corrected qualification used the canonical
path and retained the HTTP 200 requirement. These are harness failures, not
failed application startups; the unsuccessful records were not overwritten.

## Scope

“Listening” here means after the configured readiness gate, not the instant a
container slot is allocated. All restored nonces were new. Equal PIDs in separate
containers would not establish inherited processes or RAM preservation.
Production advertised `restoreLaunch: true` and `memory: false`.

The three copies were unpatched. This follow-up did not rerun browser repair
controls, compare providers, measure startup performance, or test memory cloning.
The historical baseline/correct/misleading records retain their original results.
Physical storage reclamation and charges were not measured. Sanitized observations
and source hashes do not independently replay the complete private verification.

With the key provided only in the host environment, a fresh qualification can be
run as:

```sh
node src/app-restore-launch-experiment.ts \
  --source ../web --output artifacts/my-new-app-startup-run
```

The output directory must not already exist. The runner checks capacity before
allocating resources and cleans only its journaled resources.
