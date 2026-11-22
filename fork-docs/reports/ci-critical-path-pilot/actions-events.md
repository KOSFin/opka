# Trigger and pending-context evidence

Inspected source revision: `7d7a8ffa83fdff34df5211a294f6b076bbee44b4`. Revision-specific workflow contents and job dependencies for each sampled run are in `actions-dags.json.gz`; byte-exact YAML is content-addressed under `actions-workflows/`. These are source-commit snapshots. GitHub does not return the complete original PR webhook payload or the original ephemeral merge commit in the runs list, so source snapshots are not claimed to prove the exact ephemeral merge tree.

| Event | Current `pr.yml` behavior | Interpretation |
| --- | --- | --- |
| Feature branch push without open PR | No trigger (`push.branches: [main]`) | No mandatory PR context exists yet; native qualification workflows may independently match their own branch rules. |
| Foreign-fork PR | Same opened/synchronize admission, restricted token/secrets; platform approval may hold execution | Follow-up reuse rejects foreign head repository. No actual foreign-fork Actions run measured by this audit; unit refusal is not hosted fork validation. |
| Open ordinary PR | `pull_request: opened` | Full scope decision and selected jobs; exact-source proof preserved by verify. |
| Commit pushed to open ordinary PR | `pull_request: synchronize` | New run; same PR concurrency group cancels earlier run. No separate feature-branch push run in this workflow. |
| Re-review without source push | No review event trigger | Existing exact-head result remains; review approval itself does not run CI. |
| Reopen | `reopened` | Run again, same PR concurrency group. |
| Draft opened/synchronized | Workflow starts; scope/verify draft guards skip | Draft green is not source qualification. |
| Mark ready | `ready_for_review` | Runs normal qualification. |
| Retarget PR base | `edited` not subscribed | This workflow does not deliberately refresh on base retarget alone. Any required pending behavior depends on actual branch settings/event/check semantics, not inferred here. |
| Base branch moves while head unchanged | No `pull_request` event solely because base moved | `main` push gets its own context, not a new PR exact-head result. Strict up-to-date settings would be a separate gate. |
| Merge PR to main | `push` on `main` | Scope may reuse exact prior component qualification under existing proof rules. Current measured main times must not be compared as full cold PR runs. |
| Tag push | No matching `pr.yml` push trigger | Not a mandatory PR run. |
| Publish release | `opka-release.yml` manual workflow only | Admission -> installer qualification -> exact Android acceptance -> publish, with explicit immutable-build reuse branch. |
| Manual PR Checks dispatch | `workflow_dispatch` | Normal workflow starts with chosen ref; do not dispatch in addition to an already-running equivalent PR run. |
| Re-run failed/all jobs | Same run ID, incremented attempt | Attempts retained separately; retry waiting belongs in end-to-end time. |
| Merge queue | No `merge_group` trigger in current `pr.yml` | If queue requires this check, missing merge-group contexts are a risk. Actual queue enablement cannot be inferred from YAML. |
| Cancelled prior head | Concurrency cancellation | No successful exact-head qualification; a later green head must not qualify the cancelled head. |
| Failure/skipped prerequisite | Verify evaluates selected requirements and rejects unexplained skips | `!cancelled()` keeps failure inspection possible; cancellation does not create green qualification. |

Read-only branch protection API returned HTTP 404, message `Branch not protected` (see `actions-main-protection.json`); ruleset response is saved separately. This describes the API result at observation, not permission to alter protections. The project's exact-head policy remains mandatory even if server-side protection is absent. Branch protection absence does not establish that required contexts can safely be omitted.

## Other current workflows and cancellation gaps

The two native-CLI qualification workflows subscribe only to pushes on `codex/iteration010-native-qualification` and `codex/iteration010-native-authority`, respectively, plus manual dispatch. A push on either special branch with an open PR can therefore start its native qualification alongside PR Checks. A generic feature push (including this pilot branch) starts neither. These isolated credential qualification jobs are not the PR aggregate and were not dispatched for this audit.

`opka-updater-smoke.yml` additionally subscribes to PR paths covering its own workflow, packaged Playwright config/journey and installer probe. Its default PR event types are opened/synchronize/reopened. Matching PRs can run that extra released-updater journey beside the normal Electron/installer work; nonmatching path-filtered workflow contexts may be absent/pending if configured as required. The current protection/ruleset responses do not show such a requirement. This secondary workflow lacks a draft guard and concurrency cancellation, so its matching draft/old-head work can continue. It does not substitute for `pr.yml:verify`.

`converted_to_draft` is absent from pr.yml event types. Converting an already-running PR to draft alone therefore does not start a cancelling workflow. A subsequent synchronize does create a new, draft-skipped run in the same PR concurrency group and supersedes the old run. Re-requested review and pull_request_review events are absent. A re-review of unchanged source is free but does not refresh a changed synthetic merge tree.

Reusable installer/server-template workflows expose only workflow_call; they do not independently react to feature/tag pushes. Android acceptance supports workflow_call and manual dispatch; release and updater publication checks are manual. There is no automatic tag/release-event publication in these current YAML files. The pilot's manual `aggregate_probe` input adds diagnostics alongside full qualification; normal PR/main events leave it skipped, and no qualification dependency is bypassed.

The current top-level PR concurrency key uses the PR number; a manual dispatch uses the ref. Manually dispatching the same source while an ordinary PR run is active can duplicate work because those keys differ. This audit checked for an equivalent active run first, used one manual candidate run, and opened the PR as draft: its automatic PR run contained only skipped jobs. Reusable Android concurrency is ref-scoped and cancel-in-progress:false, so queue/cleanup behavior inside a cancelled caller must be measured rather than equated with immediate physical process termination.
