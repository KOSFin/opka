## ELI5

The final required check currently installs the application's dependencies just to inspect other checks. This pilot runs the same decision and writes the same source proof using Node and repository files only. It does not make ordinary PRs ten times faster: recent successful PRs take a median 34m06s, and Android is often the longest branch.

## What Changed

Extract the existing aggregate validator and follow-up policy without changing accepted results. Keep `pr.yml:verify`, all dependencies, selected platform work, cancellation behavior and qualification JSON. A manual diagnostic compares the pinned baseline `7d7a8ffa` against the candidate on identical historical red/green gate inputs and all lane/result combinations on Linux, macOS and Windows. Full qualification still runs alongside the diagnostic.

## Why

This removes a small serial installation without weakening coverage. Broad affected-build/cache changes need stronger dependency evidence; existing component selection already handles renderer/cloud/mobile distinctions. The report separates real timings, validator replay and forecasts, and documents event gaps and GitLab portability. No mandatory work moves after merge.

## Linked Issue

Owner-requested CI investigation; no separate issue.

## Visual Proof

N/A — CI scheduling only; no application interaction change.

## Testing

- [x] Independent source review and syntax/diff checks.
- [ ] Full exact-head qualification: pending manual run linked below; this draft must not be treated as qualified for merge.
- [x] Automated cross-platform before/after diagnostic added.

Local test admission was refused because the host has less than the required 8 GiB free reserve. No limits were bypassed and no SDKs were installed. Remote validation: https://github.com/KOSFin/opka/actions/runs/45075379341 (candidate `6f4a8d2cacd12439e60077637b76c836bde5cc6a`). Draft PR runs are intentionally skipped, so the manual run is the only full candidate run.

## AI Disclosure

Implemented and reviewed with native Codex agents; human owner requested the work. Model identifiers are not asserted from inference.

## Review

Independent review found a missing import during extraction; corrected before dispatch. Policy and validator source equivalence verified. Complete result and evidence limitations will be recorded in `fork-docs/reports/ci-critical-path-pilot/`.

## Agent skill upstream boundary

- [x] Not applicable, or this change copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

No merge, release, service installation, protection changes or installed-application changes. No local/SSH/WSL application behavior changes. Aggregate remains cross-platform; the required verifier continues on Ubuntu.

## Checklist

- [x] I explained the before/after, mechanism and alternatives.
- [x] N/A visual proof explained.
- [x] Self-reviewed and independently reviewed.
- [x] Platform and remote impact considered.
- [ ] CI evidence complete; keep draft until reviewed.
