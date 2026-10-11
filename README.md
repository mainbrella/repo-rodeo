# My pick: Repro Rodeo

An open-source GitHub bug reproduction and repair playground

# Turn a GitHub issue into a living, shareable bug reproduction.

Here's the idea:

Someone files a GitHub issue saying their web app is broken. You want to help, but you don't have their computer, dependencies, environment, or a reliable way to reproduce it.

With Repro Rodeo, you paste the issue URL. It sets up the project in an isolated Linux sandbox, helps reproduce the bug, and gives you a live, interactive version of the broken application.

Then comes the fun part.

You can fork that exact prepared environment into three independent sandboxes, assign different AI coding agents to attempt fixes, watch them work, and compare their results.

At the end, you get a live before-and-after demonstration, a reproducible failing test, and potentially a real pull request that fixes somebody's problem.

This would be useful even if the AI agents never fixed anything. Giving a maintainer a one-click, reproducible environment with a failing test is valuable by itself.

And that's why I like this project much more than another agent benchmark. You're building something that developers could actually use.

## The experience you're building

Imagine somebody reports that a drag-and-drop editor loses elements after saving. A successful Repro Rodeo page would show:

## Repro Rodeo

Example issue: Editor loses elements after saving

Reproduced

Original app

Element missing!

Base commit · Test failing

Candidate fix

Element preserved

Patch commit · Test passing

Patch attempts

Agent A · Minimal fix

12/12 tests

Agent B · Refactor

10/12 tests

Agent C · Alternative fix

12/12 tests

Live previews

Browser replay

Git diff

Run logs

Illustrative product UI, not actual test results.

The killer feature isn't three AI agents. It's that the maintainer can click the broken app, see the bug, then click the repaired app and verify the difference without installing anything.

That is compelling enough to give away as a free open-source service, at least for a limited number of runs.

## Why this will force you to learn sandbox infrastructure

Every one of these becomes necessary because of a real user need.

| Feature                 | What happens in Repro Rodeo                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| Custom images/templates | Installing a big application's dependencies takes time. Prepare once and reuse |
| Filesystem snapshots    | Preserve the exact environment after a successful build                        |
| Forking                 | Start three independent repair experiments from an identical state             |
| Persistent volumes      | Reuse large dependency caches and store artifacts across sandbox lifetimes     |
| Pause/resume            | The maintainer returns tomorrow and wants to continue investigating            |
| Network restrictions    | Unknown GitHub projects run untrusted install scripts and code                 |
| Secrets vault           | Agents need limited GitHub or model API access without reading raw credentials |
| Background execution    | Tests and agents continue after someone closes the browser                     |
| Public previews         | Let maintainers interact with the app without a local installation             |
| Computer use            | Reproduce UI bugs with real clicks, typing, browser screenshots and recordings |
| File API                | Extract logs, patches, screenshots, traces and test artifacts                  |
| Webhooks/events         | Notify your application when environments start, stop, fail or finish          |
| Metrics                 | Determine why a repair job failed, stalled or exhausted memory                 |
| Warm pools              | Make the Fork and Try button feel instantaneous                                |
| Lifecycle/cleanup       | Automatically reclaim expensive environments after review                      |

These aren't invented exercises. They arise naturally from the product.

E2B documents sandbox forking, memory-preserving persistence and secret injection. Daytona documents snapshotting, volumes, computer-use tooling and warm pools (although warm pools need organization enablement).&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.e2b.dev\&sz=32)

docs.e2b.dev

+4



## Your assignment: one real bug, three platforms

### The core challenge

Find one genuine, unresolved bug in an open-source web application and turn it into a reproducible, interactive demonstration on all three providers.

I'd start with a repo you control, possibly `mainbrella/web`, provided the bug is real and repeatable. For the public launch, add a bug reported by someone else in an unrelated open-source project.

The product should support a simple reproduction recipe, for example:

```
repository: owner/project
commit: abc123
setup: npm ci
start: npm run dev -- --host 0.0.0.0
port: 3000
reproduce: npx playwright test repro.spec.ts
```

The issue URL gives context; the test script establishes what is actually broken. Don't make an LLM's unsupported assertion count as reproducing a bug.

Pass 1 — E2B: Make the broken app come alive

Build the app, capture browser evidence, checkpoint the prepared environment, fork three independent repair attempts, run tests and publish a live preview. Also test leaving a sandbox paused and returning later.

Deliverable: the first genuinely usable Repro Rodeo page.

Pass 2 — Daytona: Make it fast and repeatable

Recreate the same experience with the same repository, tests, agent and prompts. Explore Daytona's native snapshot/fork options, shared volumes, computer-use API and warm pools where enabled.

Deliverable: the same user-facing product, powered by a second provider, with real performance and lifecycle comparisons.

Pass 3 — MainBrella: Find out what your platform really needs

Repeat without changing the product requirements. Use MainBrella's current filesystem save/restore and execution APIs. For features that don't exist, record the gaps rather than pretending a workaround is equivalent.

For example, restoring three saved filesystems isn't the same as forking a live process with its memory. R2 object storage isn't automatically a shared filesystem mount.

Deliverable: a working MainBrella version and an evidence-backed feature roadmap.

## Make the benchmarking part of the open-source product

Don't write three separate implementations of Repro Rodeo. Build one application with three provider adapters, and keep the experience consistent.

The project could expose a public comparison that records these measurements for each provider:

Run scorecard

Use measured values only, from the same pinned application and comparable resource allocations.

| Metric                                                 | E2B | Daytona | MainBrella |
| ------------------------------------------------------ | --- | ------- | ---------- |
| Cold start to first successful command<br>seconds      | —   | —       | —          |
| Repository ready and dependencies installed<br>seconds | —   | —       | —          |
| Clone prepared environment<br>seconds                  | —   | —       | —          |
| Live preview ready<br>seconds                          | —   | —       | —          |
| Resume a preserved environment<br>seconds              | —   | —       | —          |
| Compute cost for a completed bug run<br>USD            | —   | —       | —          |

Eventually add success rates, p50/p95 latency, resource consumption, and feature limitations.

I would also deliberately run three failure scenarios: disconnect while an agent is executing, return to a paused environment after an extended break, and delete a sandbox while preserving its evidence and results.

Those cases teach you far more about a provider than a successful `echo hello` benchmark.

## What makes this a serious open-source project

There are already issue-to-PR agents, including [ProPR](https://github.com/integry/propr) and research projects like [PatchSmith](https://github.com/thromel/patchsmith). I wouldn't compete by building another general coding agent.

Instead, own the reproducibility, interactive preview and independently verifiable evidence layer. Use an existing coding agent to propose changes; Repro Rodeo should be responsible for making the bug and its proposed fixes inspectable.

Start with public repositories and user-authorized GitHub write access. Keep credentials outside untrusted code where possible, set resource and spending limits, restrict public previews, and expire environments. Not every repo will install successfully; a useful failure report should be a first-class result.

### Your definition of done

The project is genuinely successful when a developer can give you a real GitHub issue, and you can produce:

- A verified failing reproduction on the original commit.
- A live link to the broken application.
- At least two isolated repair experiments built from the same prepared environment.
- A candidate fix that passes the reproduction test and relevant regression tests.
- A live before-and-after comparison, with logs, screenshots, source diff, and a human-approved PR.
- An evidence record that survives the sandboxes being destroyed, plus the cost and timing results from E2B, Daytona and MainBrella.

A partial failure should still produce a useful report, rather than a fake green checkmark.

## The blog series practically writes itself

One Bug, Three Clouds: Building Repro Rodeo

The opening post: why GitHub bug reports need executable environments.

I Forked a Running Computer to Fix a Bug

E2B, snapshots, parallel agents, and how identical environments diverge.

What Daytona Does Differently

Volumes, warm pools, computer use and real persistence behavior.

Rebuilding Repro Rodeo on MainBrella

An open accounting of what works, what needs improvement, and what isn't yet possible.

Three Clouds, One Real Bug: The Results

Public measurements, failure stories, reproducible code, and the actual pull request.

The part I'd be most excited about is the final public demo: someone clicks an issue, sees a bug happen, watches three independent repair attempts, and interacts with the fixed application. Then they can run the same job themselves.

That turns your experiment into a useful developer tool, gives MainBrella a serious reference application, and produces an unusually credible comparison of E2B, Daytona, and MainBrella.
