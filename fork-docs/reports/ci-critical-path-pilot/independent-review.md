# Independent review of dependency-free aggregate extraction

Reviewer: native research/review worker, independent of implementation. Reviewed working-tree diff against `7d7a8ffa83fdff34df5211a294f6b076bbee44b4`. Scope: `pr.yml`, component scope, follow-up proof/policy, aggregate and contract command. Dispatch benchmark was still being added by the parent and is not covered by this first review.

## Finding requiring correction

**R1 — missing `isFollowupProof` import silently disables approved follow-up reuse.** `config/scripts/opka-ci-component-scope.mjs` still calls `isFollowupProof(proof)` in `detectCiScope`, but its original import was removed. The reference throws inside a broad catch, so an otherwise valid follow-up proof falls through to normal qualification. This remains fail-closed but changes the approved optimization and violates the claimed mechanical equivalence. Restore that import from `opka-ci-followup-policy.mjs` or the existing re-export. The existing follow-up scenario test should run; syntax checking cannot find this error.

## Verified by source comparison

- Extracted policy matches the original policy byte for byte after removing only the original unrelated `WORKFLOW` declaration and the new export list. Allowed paths, failure sets, required-job names and proof validation are unchanged.
- `evaluateCiResults` matches the original function byte for byte. Selected jobs still require success, unselected jobs require skipped, and unexpected dependency counts/scope failure reject qualification. Existing handling of `failure`, `cancelled`, skipped and missing lanes is preserved.
- Qualification JSON fields and their ordering are unchanged: schema version, tree, head, run ID, attempt, event and full scope. Writing still occurs only after successful validation. The new function creates the output directory first, equivalent to the original entry point's setup.
- Aggregate's import closure contains only Node builtins and local source files (`followup-policy`, `script-entry-detection`). It does not need dependency installation or built internal packages. `script-entry-detection` already handles real paths and Windows file URLs.
- Verify's job ID/name, dependencies, conditional, runner, artifact name/path and retention remain unchanged. No selected test/build/platform work moved after merge or was removed. The replacement setup-node action reads the same package.json runtime declaration and disables automatic package-manager caching.
- New source paths are not added to narrowly approved follow-up path lists. They therefore do not create a new route for unqualified reuse; unknown inputs continue to select full qualification.
- Existing public exports for `CI_LANES`, `evaluateCiResults` and `isFollowupProof` remain available at their old module locations. Follow-up proof's own references have corresponding imports in the extracted policy.

## Smallest safe design assessment

The extraction is proportionate to removing the final aggregate's dependency install. It reuses the existing proof validator rather than maintaining two copies. Keeping the legacy `--verify` entry as a delegating compatibility path is reasonable. Exporting the narrowly used policy objects does not broaden accepted proof values. Removing dependencies from `scope` simultaneously would enlarge the change because scope executes Git/process-host and proof lookup; leaving it for a later separately measured change keeps this pilot reviewable.

Do not claim tenfold improvement from this extraction. Its maximum benefit is the install/internal-package/setup time removed from the final serial job, while the other branches remain unchanged. Cold/warm or cross-platform benchmark results remain pending at review time. An extraction/parity test alone cannot establish a shorter live merge-ready path.

## Checks actually executed by reviewer

Lightweight Python source comparison: both policy and aggregate validator equality checks returned true. `node --check` returned 0 for aggregate, policy, component scope and follow-up proof. No heavy suite, native build, SDK install, workflow dispatch or external write was performed by this reviewer. These checks do not establish remote workflow success.

## Journal

- 2026-11-23 03:00:23 +05:00 — Reviewed current extraction; found R1 and sent immediate correction request to parent. Byte-equivalence checks and four syntax checks passed. Next: restore import, execute follow-up regression under admitted test command, review the completed dispatch probe separately, then inspect exact-head remote evidence. No merge/release authorization or completion is implied.

- 2026-11-23 03:00:23 +05:00 — Follow-up inspection confirms the parent restored the missing policy import in component scope. R1 is corrected in source; execution of the follow-up regression remains part of the parent’s validation.

## Dispatch probe follow-up review

At 2026-11-23 03:00:53 +05:00, the proposed diagnostic was dispatch-only, with Ubuntu/macOS/Windows matrix, no publishing or credentials persistence, and isolated artifact names. It first imports/executes the candidate without installing dependencies, then checks the baseline dependency manifests for equality before installing and comparing evaluator results. The probe is diagnostic and does not replace or weaken any existing aggregate dependency. Its synthetic qualification is not uploaded under the production proof name.

Two improvements were sent to the parent: assert absent node_modules before the cold case (recording absence alone does not enforce the intended experiment), and label candidateMs/baselineMs as evaluator-loop time because the timer starts after module imports. Use Actions step timestamps to assess setup and process-level wall time. The historical input JSON was still being produced at inspection time, so historical provenance and complete remote results were not yet reviewed.

## Final source/report audit — 2026-11-23T03:08:37+05:00

Reviewed committed implementation `6f4a8d2cacd12439e60077637b76c836bde5cc6a`, the completed diagnostic source, report README and event matrix. No implementation blocker found in this bounded extraction. The earlier missing import and cold-precondition assertion are fixed. Fixture access now correctly destructures `context().state`. Candidate imports use only builtins/local source in the dependency-free aggregate; baseline imports run after matching dependency manifests and installation. Normal PR/main paths do not execute the opt-in diagnostic. Existing qualification producer lookup still requires `pull_request`, so a manual diagnostic cannot become reusable PR qualification.

Read the six saved diagnostic JSON receipts: all three OSes report candidate SHA `6f4a8d2cacd12439e60077637b76c836bde5cc6a`, 2758 no-node_modules cases, 2760 after-install parity cases, and ten routing comparisons in each parity receipt. These are saved remote receipts; this reviewer did not rerun tests locally or independently query their job conclusions. Parent reports all diagnostic jobs and the five-file/171-test regression check passed. Full workflow was still running when this review was requested, so this review does not assert its aggregate is green.

README accurately separates evaluator-loop timings from startup/setup and whole workflow latency, identifies n=1 timing samples, states absence of a controlled full-chain cold/warm A/B, and limits historical replay to aggregate decisions on saved results rather than reexecuting original red tests. The 10 routing inputs exercise unchanged classification; their mixed-input case does not independently prove runtime indirect-dependency closure. That closure is intentionally unchanged. Natural recent-cohort p50/p95 values agree with the corresponding `latest_100_repo_runs_cohort` fields in saved summary; enriched older runs are separately identified.

PR-first limitation: the full manual qualification and cross-platform probe do not establish an ordinary `pull_request` exact-head qualification. The automatic draft run skips obligations. Any later merge still requires the then-current non-draft PR source to pass `.github/workflows/pr.yml:verify`; neither this review, the manual run, nor a later documentation-only commit inherits the claim automatically. This is a remaining delivery gate, not a reason to remove draft status during this authorized experiment.

Minor report clarifications sent to parent: add explicit foreign-fork PR coverage/limitation to event matrix (unit proof-refusal cases exist; no actual foreign-fork run was measured), and name retained compressed `actions-dags.json.gz` accurately. No local repeated tests, installations or external mutations were performed.

## Restored-tree and metric-correction audit — 2026-11-23T03:26:57+05:00

Read-only `git diff 6f4a8d2cac -- .github/workflows/pr.yml config/scripts` produced no differences: the current executable workflow/scripts tree is identical to the diagnostic-tested candidate. Temporary one-shot quality workflow changes are absent. No tests or build were repeated.

Independently recomputed the revised report figures from saved `actions-metrics.json.gz` and the fixed natural-cohort page snapshot without invoking the writing analysis script: 46 PR runs / 50 attempts, 5350.83 runner-minutes; earliest error over all attempts n34, nearest-rank p50 242s / p95 2321s; initial queue excluding unexecuted cancellation n45, p50 3s / p95 23s. These agree with README and `actions-summary.json`. Runner per-run totals now aggregate deduplicated attempts rather than taking the last attempt alone; all-attempt grand totals remain unchanged.

Remaining minor report correction sent to parent: `actions-evidence.md`'s initial-scheduling paragraph still said PR n46 while its appended correction and current data say n45. The main prose should also use n45. This is a documentation inconsistency, not a source/aggregate blocker. Full remote qualification was still ongoing according to the parent's status; neither restored source equality nor this report audit claims an exact-current-head PR aggregate passed.
