# Repo Rodeo article draft

Read [One bug, three clouds: building Repo Rodeo](one-bug-three-clouds.md). It is a fictional retrospective written before any provider experiments. The local fixture and experiment runner are real; provider runs, repair-agent outcomes, lifecycle stories, timing/cost comparisons, and an approved pull request are not established by this draft. The claim ledger in [`claims.json`](claims.json) tracks what still needs evidence.

## Run the local reproduction

The fixture is part of this repository, under [`fixtures/editor`](../fixtures/editor). From the repository root, install the pinned dependencies and Chromium, then run:

```sh
npm ci
npx playwright install chromium
npm run repro
```

The command starts the fixture automatically unless `REPRO_BASE_URL` points to an already-running copy. To run the fixture manually instead:

```sh
npm run fixture
```

Open <http://127.0.0.1:4175/repo-rodeo-bug>. Click **Reset demo**, move **Join the waitlist** to the first position, click **Save**, then refresh or choose **Reload saved**. The editor reports a successful save while the first block disappears after reload. The serializer filters out position zero. Saving without reordering loses the heading; repeated save/reload can empty the document. Reset clears only the fixture's local-storage key and restores its sample blocks. The page needs no login or backend.

The standalone browser suite has six checks: five intentionally fail on the seeded bug, and reset isolation passes. The correct patch passes all six. The misleading patch rerenders the draft after saving but leaves the serialization defect, so the reload checks still fail. The tests verify block IDs and values across reloads rather than relying on incidental visible copy. Playwright uses a fresh browser context per test; experiment traces and screenshots are stored with each run's evidence.

For an existing preview, set `REPRO_BASE_URL` to its origin. Keep the verifier outside any writable candidate checkout. The experiment runner does this for its local copies; it does not claim to provide security isolation for untrusted projects.

## Evidence notes

`npm run experiment` runs the seeded baseline, correct patch, and misleading patch, and records a manifest under a unique `artifacts/<run-id>/` directory. See the root [README](../README.md) for commands and the evidence fields. `npm run capture` captures the fixture against a server that is already running.

The [recorded local run](../examples/run-result.json) verifies the baseline, positive and negative controls, and seeded holdout. The capture script now checks all three blocks before reload and the exact two surviving blocks afterward before replacing either article image. The [example notes](../examples/README.md) explain how to regenerate the full evidence and interpret a dirty source revision.

The article's sections about E2B, Daytona, MainBrella, agents, lifecycle behavior, comparative measurements, and publication are scenarios to investigate, not reports of completed work. In particular, a MainBrella capability check must first try its native filesystem `POST /containers/fork` operation when that capability is advertised. Saved-workspace restore, if needed, is a separate fresh-process case; neither result establishes memory preservation by itself. No cloud provider or agent is contacted by the current local experiment.
