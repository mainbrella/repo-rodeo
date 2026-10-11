# Repo Rodeo article draft

Read [One bug, three clouds: building Repo Rodeo](one-bug-three-clouds.md).

The article is a fictional retrospective written before the product exists. Its provider runs, repair outcomes, lifecycle stories, comparison workflow, and approved PR are assumptions to replace after implementation. The local fixture and screenshot are real. Provider documentation supplies context, not evidence that we ran those services.

## Try the bug

The fixture lives in the sibling `../web` repository at `/repo-rodeo-bug`. From the Repo Rodeo root:

```sh
cd ../web
npm ci
npm run dev -- --host 127.0.0.1 --port 4175 --strictPort
```

Open <http://127.0.0.1:4175/repo-rodeo-bug>.

1. Click **Reset demo**.
2. Move **Join the waitlist** up twice, to the first position.
3. Click **Save**. The editor still shows three blocks and says **Saved**.
4. Refresh the browser or click **Reload saved**. The button disappears; two blocks remain.

The bug is intentional: the serializer filters on a zero-based position, discarding the first block. It is still present in `../web/src/repo-rodeo-bug.ts`. Saving without reordering loses the heading instead. Repeating save/reload eventually empties the document. Reset removes only `repo-rodeo-bug:v1` from local storage and restores the three sample blocks. The page needs no login or backend and makes no analytics requests.

## Run the failing reproduction

Keep the web server running. In another terminal, from the Repo Rodeo root:

```sh
cd blog
npm ci
npx playwright install chromium
npm run repro
```

On a fresh Linux sandbox, use `npx playwright install --with-deps chromium` to install browser system dependencies too. This directory owns the pinned browser-test dependency; the web app has no new dependencies.

The test asserts the desired, repaired behavior. On the seeded bug, **four tests fail and the reset-isolation test passes**. Do not mark those failures as expected in the test runner or change the assertions to accept missing blocks. After a correct repair, all five tests should pass.

The cases cover browser refresh, the Reload saved control, saving the original order, and repeated saves of edited and empty text. They compare the ordered IDs and input values, not incidental page text. Playwright creates a fresh browser context for each test. Failure screenshots and traces go to ignored `test-results/`.

To run against a cloud preview, set its origin:

```sh
REPRO_BASE_URL=https://your-preview-host.example npm run repro
```

For Vite in a sandbox, bind the dev server to `0.0.0.0`, keep the same port, and allow only the preview hostname using `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` if the provider forwards it. Run the verifier outside the agent's writable checkout, against that preview. Keep the Playwright version and browser build identical across providers.

The fixture changes are not committed or published by this task. Before the first cloud experiment, commit them and pin that exact revision, its lockfile, the reproduction, and the agent configuration. A clone of the web repository's current remote revision may not contain this route yet.

## Replace these assumptions with evidence

| Article claim | What we need from the completed experiment |
| --- | --- |
| One job works across all three providers | Three adapters running the same pinned app, reproduction, agent/model configuration, prompt, and budget; record resource allocations and regions |
| E2B copies a running starting point | Fork receipts, isolated-write checks, a process-state sentinel, refreshed preview checks, and an explicit memory-preserving pause/resume run |
| Daytona reuses prepared environments | The chosen sandbox class, snapshot ID and capture mode, app restart logs, and independent checkout checks |
| Daytona volumes and pools help | Separate volume and warm-pool runs; record organization enablement, matching request settings, cache state, idle capacity, and cost |
| MainBrella restores the prepared app | Deployment capability checks, saved-workspace ID, independent restore receipts, fresh process starts, and working preview grants; do not call this memory forking |
| Two candidates work and one hides the symptom | Actual prompts, model/agent versions, diffs, reproduction results, regression results, and before/after previews; replace the entire candidate table if the outcomes differ |
| Work survives closing the tab | Disconnect during execution, reconnect, and recover the job's output and final state |
| Returning later and deleting machines work | An extended pause/restore run, preview expiration/renewal behavior, and readable exported evidence after sandbox deletion |
| Timings and costs are comparable | Raw cold-start, repository-ready, clone/restore, preview-ready and resume measurements, plus full-run compute costs; separate cold and reused preparation, warm pools, and model costs |
| A human approved the PR | A reviewed patch and an actual approved publication action; no PR has been created here |
| The result generalizes beyond this demo | A genuinely unresolved bug in an unrelated public repository |

The docs already distinguish capabilities we should preserve in the experiment:

- [E2B forks](https://docs.e2b.dev/sandbox/fork) capture memory and filesystem state and disconnect active streams during the brief pause.
- [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/#create-snapshot-from-sandbox) distinguish container filesystem captures from VM memory captures. [Warm-pool matching](https://www.daytona.io/docs/en/warm-pools/) excludes custom volumes, environment variables, and secrets at creation.
- [MainBrella saved workspaces](https://mainbrella.com/docs/containers/#saved-workspaces) restore files into fresh containers without preserving processes or memory. Deployment flags still need checking.

## Figures and local checks

`assets/after-reload.png` is a Chromium capture of the local seeded bug, not a cloud-provider result. `assets/before-reload.png` keeps the corresponding pre-reload evidence. Regenerate both against the running route with:

```sh
node repro/capture.mjs
```

`assets/fork-and-restore.svg` is an editable schematic, with no timing scale. It compares process continuity with a fresh start; the external verifier browser belongs to neither copy.

Local verification: the browser reproduced the first-block loss at 390×844, 768×1024, 1280×800, and 1440×900. Keyboard focus after moving blocks, long labels, empty saved data, reset isolation, malformed storage feedback, touch targets, and page overflow were checked. The site build and TypeScript check pass. The web suite passes 415 of 416 tests; its existing SDK-reference synchronization test fails because `web/public/sdk/javascript.md` differs from `backend/sdk/javascript/README.md`. Neither file was changed here.
