# Measured CI history and critical path

Collected2026-11-22 UTC. Source baseline `7d7a8ffa83fdff34df5211a294f6b076bbee44b4`. All times below are measured from GitHub `run.created_at`, a proxy for push receipt; original server push timestamps were not supplied by the Actions API. “Green” means this workflow's successful `PR checks passed` job, not a claim that every review/protection requirement is satisfied.

The bounded index contains all217 repository runs. The natural cohort is every pr.yml/opka-release.yml run within the latest100 repository runs:73 runs. Six older red/green examples were purposefully added for contracts and timelines, yielding79 runs/86attempts over2026-10-22..2026-11-14. Those older examples must not be mixed into the baseline to imply a speedup. JSON summaries expose both cohorts.

| Natural recent cohort | n | p50 | p95 |
| --- | ---: | ---: | ---: |
| PR successful aggregate |12|34:06|50:30|
| PR first failed step or job, including cancelled/red attempts |34|4:02|38:41|
| main successful aggregate |12|1:05|1:23|
| successful release publication |9|40:53|82:44|

Attempt1 initial scheduling (run creation -> first runner start) is PR n46 p50=3s/p95=23s, main n14 p50=3s/p95=4s, release n11 p50=4s/p95=5s. Retry request timestamp is unavailable; retry elapsed from the original run includes prior attempts and human delay, so it is never labeled queue. Per-job scheduler delay is measured from job creation to start, with carried records excluded.

Nearest-rank percentiles. Small n and changing workflows substantially limit generalization. Main is usually fast because existing exact-tree PR qualification is reused; it is not a comparable cold full qualification. These numbers describe historical behavior, not pilot results.

Across all79 sampled runs, actual runner busy time (sum of job durations, cross-attempt carried executions deduplicated) is PR5720.48min, main20.47min, release941.93min. These are wall runner-minutes, without OS billing multipliers/plan-specific rates. They are not wall critical-path durations. `rounded_runner_minutes_estimate` is a nominal per-job minute rounding estimate, not invoice data.

## Red and green minute timelines

| Run / exact API source head | Milestone | Elapsed from run creation |
| --- | --- | ---: |
| [43628616296](https://github.com/KOSFin/opka/actions/runs/43628616296), `87a01be0d7b06e6af4fdf0419d7a1cc06e1aa3b4` | First runner starts |0:23|
| same | Scope finishes |0:51|
| same | Electron ends |9:02|
| same | Installer qualification ends |27:49|
| same | Android acceptance ends |34:19|
| same | Exact workflow aggregate succeeds |34:46|
| [43242425126](https://github.com/KOSFin/opka/actions/runs/43242425126), `b4dcf786379ad649ea1b09caa20c7e66e979f822` | First runner starts |0:03|
| same | First failure: changed-code quality |2:53|
| same | Another failure: regression3/4 |4:41|
| same | Electron fails project navigation journeys |13:31|
| same | Android finishes |31:38|
| same | Aggregate fails |32:08|
| [40347442770](https://github.com/KOSFin/opka/actions/runs/40347442770), `e60a81a6c061b3e89bd655a59b3dafd4fb7738ac` | Historical first failure: Electron navigation |5:42|
| same | Aggregate fails after parallel installers |20:29|
| [40353171792](https://github.com/KOSFin/opka/actions/runs/40353171792), `e64897e3a55df3e38f66861edf038a047e317b69` | Later repaired terminal PR aggregate succeeds |20:30|

These are different source inputs; the repaired terminal run is a timeline example, not an A/B benchmark.

[43248199414](https://github.com/KOSFin/opka/actions/runs/43248199414) is an explicit retry case: first attempt fails its aggregate32:27 after creation; second attempt becomes green50:30 after original creation. Many second-attempt successful job records carry previous execution timestamps and must not be charged as new runs. `actions-metrics.json.gz` retains per-attempt new execution counts, carried counts, initial queue, job queue sum and retry gap. Queue sums describe runner demand; they must not be added to end-to-end elapsed time. Some carried API records have `created_at > started_at`, another reason to avoid naive per-attempt arithmetic.

## Current path and constraints

The representative all-lane PR43628616296 has this observed critical sequence: initial scheduling23s -> scope28s -> Android dispatch3s -> Android job2005s -> aggregate dispatch2s -> aggregate25s =2086s. Scope and aggregate are each real complete jobs, not just their install steps. Android alone is96.1% of the measured path. Its job includes APK build611s, emulator acceptance727s, native update tests276s and JavaScript validation177s; categories do not cover every remaining overhead. Installers ran in parallel and finished before Android. Adding their duration to Android would overcount.

Observed lane predecessor of16 successful PRs in the expanded cohort: Android7, shared regression3, root regression1, Electron2, installer asset completion3. The winning path changes by input and revision. Cached installation micro-optimizations cannot remove the32-minute Android floor. Removing every second of scope+verify could reduce2086s only to2033s (1.026×); a real pilot removes less. This is an upper bound, not a predicted benchmark.

Current source DAG (expanded per revision in `actions-dags.json.gz`): PR scope -> parallel static / regression6jobs / desktop3platforms / Electron / installers / Android -> verify. Installer server-template fans out to glibc-floor x64+arm64, musl x64+arm64, persistence Linux/macOS/Windows including Windows ARM; desktop-template follows server qualification; mac installer then follows server-template+Darwin replay. Release admission -> installer qualification -> exact Android OS update -> publish, or explicit existing immutable-build reuse. Main uses the same PR graph with validated prior-tree reuse when possible. No required work has been moved behind merge in this audit.

## Four requested input classes

| Input class | Current conservative selection | Evidence |
| --- | --- | --- |
| Small renderer card edit | static+regression+desktop+Electron | Isolated real sample n=0; code-derived selection, timing forecast only. Electron318s journey step plus build/setup dominate representative run. |
| Server-only under src/main | all lanes, including Android/installers | Isolated real sample n=0. Server onboarding PR#10 also changes mobile/task/account inputs; its25:19 green is not a server-only measurement. |
| Android/mobile runtime | static+regression+Android (unknown build inputs may force all) | Android-specific driver PR#19 exists; it also alters qualification policy. Do not present it as an isolated APK code benchmark. |
| Shared host/runtime | all lanes | Representative all-lane run43628616296 measured34:46,131.8 runner busy minutes. |

Indirect dependencies require a complete trusted graph before reducing selection. Existing path guards remain conservative for unknown files. An affected-test tool or remote result cache is not sufficient proof for bypassing native packaging, OS update retention, platform ABI or opaque CLI replay evidence.

## Cache and data limits

Retained representative logs prove warm lockfile-verification, Linux native modules, Electron package and pinned replay-input cache hits. The same Electron run records a cold native-module key, then saves it. These are observed mixed-cache historical conditions, not a controlled cold/warm A/B. Replay source cache hit still required140s exact native-engine build, so download cache hits are not build-result cache hits. Explicit cache steps are timed separately; composite install/setup actions expose only aggregate REST step durations. Full internal setup/cache/install decomposition needs log timestamp parsing; unavailable inner measurements must not be filled with zero.

API step/job timestamps have second precision. `actions-step-timings.json.gz` retains every observed step interval; it separates explicit cache, composite setup/install, build, checks and artifacts/provenance by documented heuristic. These categories summarize runner work, not critical-path elapsed time. Some compile/test steps combine duties and remain inseparable. Artifacts retained7days are often gone; green proof retained30days was still available. No old artifact payload was assumed reconstructable.

Run head SHA is the PR source head. Checkout `scope.head` can be a distinct synthetic merge commit: green43628616296 checked `87b2dd3cf75ad238a9647dfd80b4fe9ce1dfa2ba`; red43242425126 checked `35a45c9eac8e9bb07e34742bc3be7b50f216b4fe`. Exact scope+needs recovered from public gate logs are in plain `actions-gate-input-*.json`; successful proof is also retained. These validate aggregate logic only, not historic underlying tests. Workflow snapshots use source-revision YAML because old synthetic merge objects are not local; original event payload absence is explicit.

## Reproduction

From this worktree, with read-only gh authentication and Python3/PyYAML6.0.3 already available:

```sh
python3 fork-docs/reports/ci-critical-path-pilot/actions-collect.py
python3 fork-docs/reports/ci-critical-path-pilot/actions-dag.py
python3 fork-docs/reports/ci-critical-path-pilot/actions-analyze.py
python3 fork-docs/reports/ci-critical-path-pilot/actions-gate-inputs.py
```

Collection is resumable and reuses captured gzip datasets; it does not repeat all APIs on rerun. The initial page snapshots intentionally fix the historical cohort. Gate-input recovery downloads only public job logs and an explicitly bounded tiny proof archive. Scripts never install dependencies, dispatch, rerun, publish or change protections. See `actions-events.md` for event coverage and pending-context risks. Raw JSON compression is lossless and recorded in `actions-compression.json`.

Метрика первой ошибки уточнена: берётся самый ранний failed step/job среди **всех attempts одного исходного PR run**, включая затем успешно исправленные retry. Поэтому n34/p50 4:02, а не n31/p50 3:58 по одним последним attempts; per-attempt исходные значения сохранены.
