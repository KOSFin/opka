## ELI5

This investigation did not establish a tenfold faster PR gate. Recent successful PRs had a median 34m06s and p95 50m30s (n=12). Android usually determines the longest full path. The small pilot removes the application's dependency installation from the final required check while preserving its decision and source proof.

## What Changed

Extract the existing result validator and follow-up policy into dependency-free modules. Keep `pr.yml:verify`, all selected checks/platforms, failure handling, public exports and qualification schema. A dispatch-only diagnostic compares the pinned baseline against the candidate on identical historical red/green inputs and result combinations on Linux, macOS and Windows. It runs alongside full qualification.

## Why

The final gate only inspects results and writes provenance; it can do so without installing the application. This removes a serial installation without introducing a second selection/cache mechanism. Broader affected-build or native-result reuse needs stronger indirect-input evidence. No mandatory work moves after merge.

## Linked Issue

Owner-requested CI investigation; no separate tracking issue.

## Visual Proof

N/A — CI only; no application interaction change.

## Testing

- [x] Full manual qualification [45075379341](https://github.com/KOSFin/opka/actions/runs/45075379341), attempt1, implementation `6f4a8d2cacd12439e60077637b76c836bde5cc6a`: success, all six lanes; verified proof head/tree/run/attempt/event.
- [x] Three-OS diagnostic: 2758 cases without node_modules, 2760 baseline/candidate cases including retained historical red/green results, ten routing comparisons.
- [x] Five targeted regression files: 171 tests passed.
- [x] Separate meaningful diff-quality [45076783719](https://github.com/KOSFin/opka/actions/runs/45076783719): six files, zero new findings. Manual full fallback compares HEAD to itself, so its changed-code step alone was insufficient. The temporary draft-only quality job was removed afterward.
- [x] Independent source and measurement review; executable files still match the tested implementation exactly.

Observed verify duration: 25s historical →15s candidate. Whole gate: 34m46s →34m41s; events, toolchain, cache and test selection differ, so the five-second difference is not a controlled full-workflow speedup. Candidate consumed 141.43 runner-min including 3.17 diagnostic minutes; no overall cost saving was established. Full cold/warm pipeline A/B and hosted foreign-fork execution were not measured. Scoped cold/cache-independent gate behavior and fork-proof refusal were checked.

Local test admission initially refused the host's disk reserve. After owner cleanup, checks already running in Actions were not repeated locally. No SDKs, services or installed applications were changed.

Reports, event matrix, red/green timelines, source snapshots, compressed raw datasets, commands and GitLab/CI-v2 assessment: [audit report](https://github.com/KOSFin/opka/blob/codex/ci-critical-path-pilot/fork-docs/reports/ci-critical-path-pilot/README.md).

**Keep draft.** The successful run is workflow_dispatch on the implementation commit; subsequent commits contain reports/journal. It is not pull_request qualification for the current head. Before any future merge, require the non-draft exact-head `pr.yml:verify` and full workflow success.

## AI Disclosure

Implemented and independently reviewed with native Codex agents, as requested by the owner.

## Review

Same validator/policy source before and after; cancellation, missing/failed/unexplained skipped lanes and invalid follow-up evidence still reject qualification. Unknown paths remain conservative. Review details and transient investigation corrections are preserved in the append-only journal.

## Agent skill upstream boundary

- [x] Not applicable, or this change copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

No merge, release, protection changes or service installation. Native platform/SSH/WSL application behavior is unchanged. Full hosted Linux/macOS/Windows/server/Android qualification completed; no local UI or physical-device tests were launched.

## Checklist

- [x] Focused reversible pilot, with the larger evidence archive kept under fork-docs/reports.
- [x] Before/after, mechanism and alternatives explained.
- [x] N/A visual proof explained.
- [x] Correctness, platform, remote and provenance reviewed.
- [x] Required CI and scoped quality checks executed as listed; no claim of a repeated full monorepo lint/local build.
