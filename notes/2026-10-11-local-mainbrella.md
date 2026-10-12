# First local Mainbrella end-to-end run

October 11, 2026 (America/Los_Angeles). Status: first local run completed;
expected editor outcomes verified. One baseline container remains available
for inspection. Two provider snapshot images remain after API cleanup.

The [sanitized result](mainbrella-local-20261011-01.json) records source hashes,
browser outcomes, lifecycle checks, evidence checksums, and remaining resources.

## Scope

Use the existing Mainbrella frontend at `http://localhost:5173` and its API at
`http://localhost:8787` as the control plane. Provision the actual `../web`
checkout through Mainbrella into an OrbStack-backed container. Run this repo's
external browser verifier against that container's protected preview at
`/repo-rodeo-bug/`. The host's copy of the editor is not the test target.

This is a local development run, not production or E2B qualification. The
deterministic repair controls are the first step; no AI repair agent is involved.

## Discovery

- `repo-rodeo`, `../web`, and `../backend` were clean when inspected.
- Web source commit: `ba4d74f2d649ce4bc137e3d25610f706ce1fbe9b`.
- Host Node is `22.22.2`. Docker uses the `orbstack` context.
- The API's advertised version is `2026-10-11`. `/capabilities` reports
  `persistence.filesystemFork=false`, `filesystemAfterStop=false`,
  `snapshots=true`, `workspaces=true`, `memory=false`, and protected previews.
- Following the README, native fork is unavailable in this deployment. Test
  saved-workspace capture and fresh-process restores as a separate path; do not
  enable release gates just to get a passing fork test.
- An existing `MAINBRELLA_LOCAL_API_KEY` in the backend's ignored `.env`
  authenticates to the local API. Initial provisioning required no new login or
  funding. There were no running containers in this account. The later quota
  finding required a separate disposable local fixture for capture and restore.
- The full web app has the same deliberate `position === 0` serialization loss
  as the standalone fixture. The existing six browser checks use matching labels
  and test IDs, so they can be reused unchanged.

## Test sequence

1. Record source, lockfile, verifier hashes, capabilities, and pre-run inventory.
2. Archive tracked web source; upload through Mainbrella's file API, install
   dependencies in a Small Node container, and start the web app there.
3. Issue a protected preview and establish the expected five persistence failures
   plus the passing reset-isolation check with the independent verifier.
4. Save the prepared filesystem. Restore three independent branches from that
   one save, inspect process state and dependency preservation, and check writes
   remain independent.
5. Verify baseline, correct repair, and misleading repair in separate restores.
   Adapt the two fixture patches to the TypeScript web source and retain exact
   patch bytes and hashes. Keep the browser tests outside every guest.
6. Check managed-job reconnection, preview revocation, and cleanup. Retain one
   clearly identified baseline container for interactive inspection if useful.

Raw evidence belongs in the ignored `artifacts/` directory. Preview URLs contain
bearer credentials, so raw receipts, browser reports, traces, and screenshots
must remain private. Commit only sanitized notes and result summaries.

## Run log

Evidence directory: `artifacts/mainbrella-local-20261011-01/`. Timestamps in
receipts are UTC (October 12); this note uses the local October 11 date.

1. Archived all 411 tracked files from the clean web commit with `git archive`.
   The gzip tar is 15,160,966 bytes. No host `node_modules`, environment files,
   or API credentials were uploaded. Created a Small catalog Node container
   through `POST /containers`, uploaded through `PUT /containers/files/transfer`,
   and extracted to `/workspace/web`.
2. Guest tooling is Node `24.21.0` / npm `11.19.0`, distinct from the verifier's
   pinned host Node `22.22.2`. `npm ci --no-audit --no-fund` succeeded (103
   packages, approximately 330 MiB installed). The installed source and lockfile
   hashes match the archive. `npm run type-check` passed inside the guest.
3. First preview/browser run failed with HTTP 403, correctly classified
   **unverified** by the external verifier. Mainbrella forwards the guest Host
   as `container`, so Vite needs that exact additional allowed host. The
   run-specific launcher uses `allowedHosts: ['container']`, binds
   `0.0.0.0:5173`, disables HMR, and sets `VITE_API_URL=http://localhost:8787`.
   The last setting prevents the embedded web checkout from defaulting to the
   production API on its preview hostname. The host web checkout is untouched.
4. The launcher's Vite plugin installs `/__rodeo_process` before fallback
   middleware. It reports a nonce generated only in process memory, PID, and
   start time. An initial harness version registered after fallback and returned
   the site's HTML; both harness versions are retained in the evidence.
5. `prepared-baseline-v2` verified the expected result: five failures, each
   specifically losing only the first block after reload, and one passing reset
   isolation check. Chromium version: `153.0.8010.12`; holdout seed: `12345`.
6. `POST /workspaces` on the existing account returned HTTP 429
   `workspace_quota_exceeded`. Inventory reports 100 saved workspaces versus
   a limit of 20, 200 GB reserved versus 160 GB, and 102 monthly saves versus
   100. No existing workspaces were deleted, and no limits were changed.
7. For the capture/restore experiment, seed a disposable local user, API key,
   and one-day Pro trial directly in local D1 via `wrangler d1 execute delta
   --local --file …`. This is a synthetic entitlement fixture, not payment,
   signup, or coupon-redemption verification. It uses the same running local
   API/Workers/OrbStack stack. The initial generated key used base64url; the
   API correctly rejected it (401) because keys require `mb_` plus 64 hex
   characters. Corrected the disposable key format and retained both attempts.
8. Verified the baseline again in that account, then saved the prepared
   filesystem with `POST /workspaces`, `stop:false`, and a persisted idempotency
   key. The source's in-memory nonce and PID stayed the same across capture.
   The capture reported 426,092,457 bytes. Restored three containers with
   `POST /containers` and the same `workspaceId`, each with its own persisted
   creation key. No restore ran `npm ci` again.
9. Every restore retained the source lockfile, editor source, installed-dependency
   lockfile, and a prepared marker. Before restarting Vite, every restore's
   localhost probe failed with connection refused. Explicitly starting the server
   produced a fresh nonce in each branch. This demonstrates filesystem restore
   with fresh processes, not RAM preservation.
10. Wrote a different value to `/workspace/branch-marker` in each restore.
    Each branch read its own value, and the source had no such file. Applied
    [the correct patch](patches/web-correct.patch) and
    [the misleading patch](patches/web-misleading.patch) in their respective
    containers. These adapt the fixture controls to `src/repo-rodeo-bug.ts`;
    the browser tests were unchanged and ran on the host.
11. All restored branch outcomes matched their expected classifications:

    | Branch | Browser tests | Independent verification |
    | --- | --- | --- |
    | Baseline | 5 failed, 1 passed | Exact first-block loss reproduced |
    | Correct repair | 6 passed | Document preserved, including all 12 holdout reloads |
    | Misleading repair | 5 failed, 1 passed | Exact first-block loss still reproduced |

12. Compared all 411 tracked web files against a host-generated SHA-256
    inventory in all five containers. Every file matched, allowing only the
    expected editor patch in the two repaired branches. Host web/backend
    checkouts and verifier inputs remained unchanged.
13. Browser checks at 390×844, 768×1024, 1280×800, and 1440×900 confirmed the
    repaired reorder/save/refresh path, all three blocks, no horizontal overflow,
    and no page exceptions. Screenshots were retained; mobile editor and desktop
    dashboard screenshots were visually inspected.
14. Seeded an expiring browser session for the disposable account and opened the
    real control plane at `http://localhost:5173/dashboard/?view=ad-hoc`. It listed
    all four fixture containers and hid unsupported native Fork and Stop/Resume
    controls. An earlier harness used `?view=containers`, which resolves to
    Overview; that selector timeout and diagnosis are recorded. Login itself
    was not exercised. The trial fixture's overview displays prepaid balance
    $0.00, so its overview is not a verification of trial usage reporting.
15. Submitted an eight-second managed execution through the browser session,
    attached to its SSE output, and closed the browser after its first stdout
    event. A new browser session recovered the same execution ID with exit 0
    and both output messages. Resuming the SSE stream at cursor 1 returned the
    remaining output. Disconnect did not cancel or duplicate the job.
16. Submitted a second checkpoint, interrupted its client after 150 ms, then
    retried the exact saved body and idempotency key. A further replay returned
    the same workspace ID. Inventory and usage increased by exactly one saved
    workspace and one save, not one per request.
17. Revoked all four fixture previews and observed HTTP 404 for each, both before
    and after deleting its exact container generation. Deleted both fixture
    workspaces. API inventory then contained no fixture containers or saved
    workspaces; reserved live workspace bytes were zero. The local dev launcher
    removed the four workload containers and their proxies. Deleted only the
    disposable D1 user/key/session/trial fixture and verified its old API key
    returned 401. The original account's 100 workspaces were unchanged.
18. API workspace deletion did **not** remove the two native Docker snapshot
    images. Both had zero attached containers; their names and IDs are recorded
    in the result. Mainbrella's documented deletion revokes restore access and
    leaves physical retention to the provider. This run does not establish
    eventual local snapshot garbage collection. No global Docker prune was run.

## What remains running

The original account retains container `small`, generation
`2026-10-12T00:54:51.348Z`, with the unpatched full web app. Find it in the local
[Ad Hoc dashboard](http://localhost:5173/dashboard/?view=ad-hoc).
Its app listens on port 5173 **inside the container**. The external test target
is its protected preview through port 8787, never the host editor on 5173.

`artifacts/mainbrella-local-live.json` contains its private preview URL and expiry.
The initial preview grant expires October 11 at 6:55:33 PM Pacific, and the
container also has a 30-minute idle timeout. The hard deadline is October 12 at
5:54:51 PM Pacific. These are upper bounds, not an availability guarantee.
For a new link while the generation is still running, use its dashboard action
menu → Preview, enter port 5173, and select Create link. To remove the retained copy, delete that
specific generation from the dashboard or the API. Deleting it discards its
unsaved filesystem; this run did not create a workspace in the original account.

## Repeating the run

1. Start the normal local backend and frontend, with OrbStack available. Record
   `/capabilities`, `/containers`, and `/workspaces` **before provisioning**.
   Use a test account with available starts, compute, workspace count/capacity,
   and monthly save budget. The quota failure above makes that preflight useful.
2. Pin the full web commit and lockfile; archive tracked source only. Create a
   Small Node container through the API with a saved creation key. Upload the
   archive with `/containers/files/transfer`, extract, install dependencies,
   and verify hashes. Never put the provider key in guest files or environment.
3. Start Vite on `0.0.0.0:5173` with the exact additional allowed host `container`
   and explicit local `VITE_API_URL`. The run's `rodeo-server-v2.mjs` adds the
   in-memory process probe through a `configureServer` plugin. It disables HMR;
   this test therefore does not qualify Vite WebSocket/HMR forwarding.
4. Publish a protected preview. First require HTTP 200 and actual editor markup,
   then run the unchanged verifier using a new evidence directory:

   ```sh
   REPRO_BASE_URL="$PREVIEW_ORIGIN" \
   RODEO_SEED=12345 \
   RODEO_JSON_REPORT="$EVIDENCE/report.json" \
   RODEO_TEST_OUTPUT="$EVIDENCE/test-results" npm run repro
   ```

   Baseline exit 1 is expected only when `verifyReport` confirms all five exact
   data-loss assertions, the reset check, and complete artifact evidence. An HTTP
   error or merely nonzero exit status does not establish reproduction.
5. If native fork is advertised, test it first. Otherwise save the prepared
   workspace, persist its receipt, and restore three fresh branches. Record
   filesystem integrity, listener absence/presence, process nonces, isolation,
   and patch hashes separately. Test all branches through their own previews.
6. Check browser reattachment and interrupted checkpoint retry with persisted
   keys/bodies, then revoke previews and delete only this run's generations and
   workspaces. Inspect actual API and Docker inventories afterward. Keep any
   intentionally retained resource explicit, and record provider snapshot images
   separately from live application resources.

The private evidence contains the actual `driver.mjs`, browser reconnection,
interrupted capture, and cleanup scripts plus per-request journals. They are
first-run harnesses, not a qualified `ProviderAdapter`. Do not rerun mutating
scripts against an old run directory: some helpers generate new operation keys.
To resolve an uncertain request, use its already persisted key and body.

## Verification and limits

- Repo Rodeo: `npm test` passed all 32 verifier/evidence unit tests;
  `npm run typecheck` passed. Guest web: `npm run type-check` passed.
- Raw browser reports, traces, screenshots, observations, receipts, source
  archive, patches, and SHA-256 inventories remain outside the deleted guests.
  The result references their checksums. No host web/backend source was changed.
- This run requests Small (0.5 vCPU / 4 GiB / 8 GB) through Mainbrella, but Docker
  inspection shows `Memory=0` and `NanoCpus=0`. The local provider did not expose
  matching per-container Docker limits; timings are not resource-normalized
  production performance or cost measurements.
- Native filesystem fork and resumable stop remain untested because capability
  discovery disabled them. No release flags were changed. RAM preservation,
  adversarial isolation, production DNS/TLS, payment verification, AI repair,
  E2B, and Daytona remain outside this run.

## Accounting and follow-up

The post-cleanup fixture inventory showed zero active containers, zero saved
workspaces, and zero live reserved workspace bytes. Its usage counters still
reported two monthly saves and 16,000,000,000 bytes for both monthly captured
and retained capture. Each save reserved the requested source disk's full 8 GB
against these capture budgets; deletion released live workspace quota without
refunding those counters. Keep those accounting values separate from the measured
426,092,457-byte filesystem capture and the two Docker snapshot images, each
reported by Docker as 1.58 GB. These figures have different sources and this run
did not reconcile their accounting basis. The two images had no attached
containers and remained after API deletion.

The original account's quota state also needs investigation before another
full run: its inventory showed 100 saved workspaces, 200 GB reserved, and 102
monthly saves against limits of 20 workspaces, 160 GB, and 100 saves. Preserve
that account's existing workspaces while resolving the discrepancy.

Next retention experiment: by **October 14, 2026 at 5:00 PM PDT**, use one
disposable local workspace, record only the exact snapshot image IDs created by
its capture, delete that workspace through the API, and recheck those same IDs
at capture, immediately after deletion, and after 24 hours. Record API inventory
and per-image attachment and size data at each point. Do not run a global Docker
prune. This is a planned experiment; no new retention measurement is claimed
here.

The 150 ms client abort in step 16 did not establish that the first checkpoint
request had been admitted before the disconnect. Although the retry returned
the same workspace ID and usage increased once, admission-confirmed idempotency
remains unverified. Repeat with an observable admission acknowledgment before
disconnecting, then replay the identical persisted body and idempotency key.

The curated [document-observation bundle](evidence/mainbrella-local-20261011-01/manifest.json)
contains the 18 allowlisted observation files referenced by the restored
baseline, correct, and misleading control verifications. It preserves the
original run ID, seed, report hashes, and per-file SHA-256 checksums. It supports
inspection of document observations; without private traces and screenshots it
cannot independently reproduce the full `verifyReport` decision.

The subsequent [tracked adapter](../src/providers/README.md) now provides the
reusable command and a separate, versioned result format. Its admission-aware
response-loss check discards a capture body only after successful HTTP headers.
A [new local preflight result](../examples/mainbrella-preflight-result.json)
confirmed the original account still exceeds quota and stopped before mutations.
The new adapter has not yet completed a full live capture/restore run; the
historical verification above remains tied to the original manual harness.
