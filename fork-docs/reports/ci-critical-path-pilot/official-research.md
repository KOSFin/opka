# Official-source review: CI critical-path pilot

Source inspection at base `7d7a8ffa83fdff34df5211a294f6b076bbee44b4`; public documentation retrieved 2026-11-22. This is a design comparison, not a measured speedup. The source receipt records final URLs, HTTP results, document hashes and time. Current vendor documentation can differ from older releases; do not import its examples without checking this repository's pinned versions (Vitest is `5.0.5`). No SDK or dependency install was performed.

## Recommendation

First preserve the existing selector and qualification mechanisms and remove demonstrably unnecessary work on their serial path. Both `scope` and `verify` currently execute the complete Node dependency action; qualification imports `@orca/process-host`, so replacing that action with plain `node` without resolving the import is unsafe. That action also builds internal packages. An admission-only dependency path or reuse of an existing account-free compiler path could be a bounded pilot if its inputs and equivalence are tested. Its benefit is bounded by measured setup time; it cannot explain a tenfold improvement when an independent Android, packaging, physical containment or Electron job dominates.

A second safe candidate is decoupling independent work currently serialized inside the shared regression job. It must still feed `pr.yml`'s exact-commit aggregate, retain its evidence and receive explicit failure/cancellation checks. Additional jobs consume scarce concurrent runner slots, so measure queue delay before choosing it. Moving checks after merge would change quality and is excluded.

Do not introduce Nx/Turbo or replace the custom dependency graph during this pilot. The repository already has transitive source selection, approved indirect-input qualification, conservative unknown-input fallback, exact-tree reuse and narrowly approved follow-up proofs. Replacing those mechanisms is materially larger than a scheduling/cache change and does not itself shorten Android or native packaging.

## What each solution actually buys

| Solution | Useful mechanism | Conditions for safe adoption here | Expected limitation |
| --- | --- | --- | --- |
| Native GitHub Actions | Shorter dependencies in DAG, narrowly keyed dependency/build caches, immutable artifacts | Preserve selected job inventory, Linux/macOS/Windows coverage, exact tested commit and final aggregate; keep untrusted PR caches away from privileged publication | Cache transfer, runner allocation and job startup remain; a new shard can lengthen account queues |
| Gradle build cache | Reuse task outputs whose complete inputs match | Correct declared inputs/outputs; verify Expo-generated project, native plugins, signing and toolchain identities; cold cache must execute normally; validate output bytes/provenance | Only cacheable Android tasks benefit; emulator/device acceptance and JS preflight still run |
| Gradle configuration cache | Reuse configuration-phase results | Confirm pinned Gradle/plugin compatibility and configuration-cache requirements; independently test cache invalidation and cold behavior | It is different from task output caching; cannot erase actual compilation/device tests |
| Nx affected + task cache | Project dependency closure plus task identity | Model workspace/project ownership, source and indirect inputs, environment/toolchain inputs and last successful base; audit omitted historical failures | Adopting a tool is not proof of graph correctness or 10× wall-clock improvement |
| Turborepo | Deterministic task hashing and output reuse | Correct task graph, outputs, environment hashes and platform/toolchain identity; preserve side-effecting tests as executed checks | Incomplete hashes can return successful stale results; restores cost time |
| Vitest selection/sharding | Related tests through import graph; parallel files | Account for dynamic imports, filesystem fixtures and generated inputs; bounded workers; measure shard imbalance and startup | It does not discover arbitrary dynamic paths; sharding splits files, so a single long file stays long |

Gradle build-cache behavior is documented in [Build Cache](https://docs.gradle.org/current/userguide/build_cache.html); configuration-phase reuse and limitations are documented separately in [Configuration Cache](https://docs.gradle.org/current/userguide/configuration_cache.html). The latter's current documentation describes changing defaults and parallel-execution behavior, which is a reason to validate the repository's pinned Gradle rather than apply latest-version flags blindly.

Nx computes affected projects using Git changes and its project graph and recommends the last successful main commit as CI base. Its [affected guidance](https://nx.dev/ci/features/affected) and [task inputs guidance](https://nx.dev/docs/guides/tasks--caching/configure-inputs) make base/head and complete input identity essential. The current inputs page also describes vendor-specific recorded-read acceleration; its marketing speed figure is not evidence for this repository. A graph migration needs shadow execution against failed revisions and changes to global inputs before it can gate a PR.

Turborepo assumes deterministic tasks and uses the declared inputs to recover cached outputs. See [caching](https://turborepo.com/docs/crafting-your-repository/caching). Runtime environment filtering is separate from inclusion of variable values in hashes: strict mode improves discipline but does not prove correctness. See [environment variables](https://turborepo.com/docs/crafting-your-repository/using-environment-variables). Signing credentials and artifact publication should not become cache payloads.

Vitest `related` supports static import relationships, including literal import expressions, but cannot resolve arbitrary computed imports. Its [CLI reference](https://vitest.dev/guide/cli.html) documents this and sharding; the [performance guide](https://vitest.dev/guide/improving-performance.html) says sharding partitions files and cautions that phase totals from parallel workers exceed elapsed time. This repository's own graph treats indirect readers explicitly and retains approved qualification coverage, which should remain authoritative.

## Aggregate and provenance requirements

GitHub can accept a skipped/neutral required check as satisfied, and a skipped upstream job can cause dependent jobs to skip. Its [required-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks) explains latest-SHA requirements and the distinction between head and test merge commits. Therefore the pilot must prove its own selected-job inventory rather than rely on GitHub's green presentation. The existing `evaluateCiResults` explicitly expects `success` for selected lanes and `skipped` for unselected lanes; preserve that contract.

The existing `verify` job uses a status-check expression and depends on all selected component lanes. Preserve its workflow identity `.github/workflows/pr.yml`, job ID `verify`, unique display name `PR checks passed`, source tree/commit evidence, and failure handling. Test `failure`, `cancelled`, unexplained `skipped`, missing results and a failed scope. Cancellation must never write qualification. A historical green context with the same display name, an installer-only run, a different SHA or a different workflow is insufficient.

The [workflow syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) documents dependency skip propagation and explicit status expressions. Workflow-level path filtering may leave required checks pending and has bounded diff behavior; it is inappropriate as the sole mechanism for a mandatory aggregate. The existing application-level classifier fails closed for unknown paths and unavailable comparisons. Keep that property and keep changes to build policy, lockfiles, CI scripts and unknown paths on full qualification.

GitHub [dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) documents branch scoping, exact/prefix restore matching and fork PR access to base-branch caches. A cache hit proves a matching storage key, not that a result was tested or that inputs were complete. Do not put auth data in cache paths. A privileged main/release job must not treat arbitrary PR-produced output as a trusted qualification. Preserve existing explicit tree/run/source checks and do not use `pull_request_target` to execute fork code with elevated credentials. Cache failure or eviction must cause ordinary execution, never skipped mandatory work.

## Required comparison matrix

- Small card change: renderer source should retain regression, all three desktop platforms and hidden Electron journeys selected by the current classifier. A setup-only pilot should select precisely the same lanes and tests.
- Server-only: inspect the actual path. `cloud/` currently selects regression; `src/main/` selects all runtime/installers/Android lanes. Do not conflate them when reporting potential speedup.
- Android: mobile runtime currently selects regression and Android acceptance, while common host/shared input enables all lanes. Gradle gains should be reported for Android separately from the PR's longest parallel branch.
- Shared code or unknown path: retain conservative complete selected work; include lockfile, workflow and generated/indirect inputs in invalidation tests.
- Historical red changes: execute the failing test or gate under both old and new admission/scheduling, and report no omission. A synthetic green unit fixture does not replace a real failed revision.
- Cold/warm: identical source and toolchain, separate cache identities or deliberately absent cache; record restored bytes/time and validation time. Do not call GitHub rerun “warm” without cache evidence.
- Fork PR: restricted read token, no secrets, base cache only where allowed, no write/publish assumption; inability to prove reuse falls back to execution.
- Cancellation/skip/failure: no qualification written for an unproven selected lane; new jobs must be explicitly added to final checks.

## CI-v2 and transfer to a second project

A useful CI-v2 is a measured, host-independent task graph with input identities and proof receipts, rather than a new brand of runner. Start with exported Actions timing records, revision-specific DAGs, cache provenance, shadow dependency closure, and an aggregate that checks every declared obligation. Add remote execution or Nx/Turbo only after those contracts are explicit. Reuse the collector/statistics/aggregate-contract method on the second project. Do not copy path classifications, cache keys, toolchain identities, historical timings or trust policy. No numeric transfer benefit is established here.

## Reproduction and journal

Run from this worktree:

```sh
python3 fork-docs/reports/ci-critical-path-pilot/official-sources.py
```

The optional web tool failed with a local routing-session error; the report was based on successful direct HTTPS retrieval of official sites instead. `official-source-receipts.json` records the retrieval, not a claim that source files remain immutable upstream. It stores no document bodies or credentials.

- 2026-11-23 02:54:29 +05:00 — Read worktree instructions and current fork iteration; inspected existing component scope, aggregate, native/dependency actions and test graph. Existing mechanisms already address several advertised affected-build features. No heavy checks or SDK installs.
- 2026-11-23 02:59:00 +05:00 — Retrieved GitHub, Gradle, Nx, Turborepo and Vitest primary sources; preserved reproducible URL/hash receipts. Actual Python and its spawned child both inherited `/system.slice/opka-ci-audit.scope`. This is cgroup-membership evidence, not proof of a separate heavy-job admission.
- Next: parent chooses a measured bounded pilot and commissions independent change review; this research alone does not prove a tenfold improvement or authorize merge/release.
