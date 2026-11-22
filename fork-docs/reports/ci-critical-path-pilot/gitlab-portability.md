# GitLab portability: contracts to preserve

This is an event/semantics mapping for a second project, not a recommendation to migrate Opka's CI. Documentation reviewed 2026-11-22; docs.gitlab.com returned HTTP 403 on this host, so the review used GitLab's public documentation source mirror. Retrieval hashes and final URLs are in `gitlab-source-receipts.json`.

| Opka/GitHub contract | GitLab equivalent and required adaptation |
| --- | --- |
| PR source/head vs merge commit qualification | Decide explicitly whether the second project uses merge request pipelines or merged-results pipelines. Persist both source revision and tested tree; the generic concept is a review qualification, not a GitHub check name. Event payloads and comparison bases require a GitLab adapter. |
| Parallel component graph, one final aggregate | Use `needs` for the actual task DAG. GitLab can start a job once its dependencies finish instead of waiting for every prior stage. The final verifier must still enumerate selected obligations. |
| Conditional jobs skipped only when unselected | `rules` can omit jobs altogether; `needs:optional` permits missing jobs. Neither should silently turn a required obligation into an optional one. Compare the produced plan with actual jobs/results explicitly. |
| Read-only fork input, trusted producer evidence | Keep untrusted merge request jobs away from privileged secrets and cache/artifact publication trust. GitLab's protected/non-protected cache split differs from GitHub branch scopes; carry trust identity in proof/cache policy instead of translating keys literally. |
| Cache miss executes ordinary task | GitLab explicitly treats caching as best-effort. Use `cache:key:files` for input-sensitive dependency keys where appropriate, and artifacts for outputs passed between jobs. A cache hit alone is never qualification. |
| Exact source/run/attempt proof | Replace GitHub API run/job identifiers with GitLab pipeline/job identifiers, keeping revision, tree, toolchain and producer identity. Reuse must check the correct project/pipeline source and successful selected jobs. |
| Avoid duplicate push/review runs | Centralize event admission in pipeline `workflow:rules`; then give each job explicit event policy. Validate branch pushes with and without open merge requests, default branch, scheduled/manual/tag pipelines, and fork merge requests. A GitHub `pull_request`/`push` expression cannot be copied unchanged. |

The [GitLab DAG documentation source](https://raw.githubusercontent.com/gitlabhq/gitlabhq/master/doc/ci/yaml/needs.md) explains scheduling through `needs`. The [CI YAML reference source](https://raw.githubusercontent.com/gitlabhq/gitlabhq/master/doc/ci/yaml/_index.md) documents `rules`, `needs:optional`, `workflow`, and explicit comparison refs. The [caching documentation source](https://raw.githubusercontent.com/gitlabhq/gitlabhq/master/doc/ci/caching/_index.md) distinguishes artifacts from caches, describes protected-branch isolation, and states that caches may be unavailable.

Port the measurement schema, conservative changed-input fallback and verifier semantics first. Path scopes, cache identities, API pagination/retry handling and merge-ready definition remain project/provider specific. No measured performance number transfers to the second project.

- 2026-11-23 03:00:23 +05:00 — Added a focused GitLab contract mapping from official documentation sources after direct documentation access failed; no GitLab pipeline, credentials or project configuration was changed.
