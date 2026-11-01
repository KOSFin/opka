"""Admit an immutable production installer run before cross-run artifact download."""
import json
import os
import re
import subprocess

REPOSITORY = 'KOSFin/opka'
PRODUCER = "Build and qualify this version's installers / Opka Android installer"


def validate(run, jobs, artifacts, source, name):
    assert re.fullmatch('[a-f0-9]{40}', source), 'Explicit built source required'
    assert name == 'opka-android-' + source, 'Unexpected candidate artifact name'
    assert run['path'] == '.github/workflows/opka-release.yml', 'Not the production release workflow'
    assert run['head_sha'] == source and run['head_branch'] == 'main', 'Installer source mismatch'
    assert run['event'] == 'workflow_dispatch', 'Production release dispatch required'
    assert run['repository']['full_name'] == REPOSITORY, 'Foreign producer repository'
    assert run['head_repository']['full_name'] == REPOSITORY, 'Foreign source repository'
    assert jobs['total_count'] <= 100 and artifacts['total_count'] <= 100, 'Producer metadata exceeds bounded page'
    producers = [job for job in jobs['jobs'] if job['name'] == PRODUCER]
    assert len(producers) == 1 and producers[0]['status'] == 'completed' and producers[0]['conclusion'] == 'success', 'Installer producer did not succeed'
    assert producers[0]['run_id'] == run['id'] and producers[0]['head_sha'] == source, 'Foreign installer producer'
    matches = [item for item in artifacts['artifacts'] if item['name'] == name]
    assert len(matches) == 1 and matches[0]['expired'] is False, 'Installer artifact missing, duplicated or expired'
    assert matches[0]['workflow_run']['id'] == run['id'] and matches[0]['workflow_run']['head_sha'] == source, 'Foreign installer artifact'
    assert type(matches[0]['id']) is int and matches[0]['id'] > 0, 'Invalid artifact identity'
    return matches[0]['id']


def main():
    assert os.environ.get('RELEASE_SIGNER') == 'true', 'Protected release acceptance required'
    assert os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'Repository mismatch'
    run_id = os.environ['CANDIDATE_RUN_ID']
    assert re.fullmatch('[1-9][0-9]{0,19}', run_id), 'Explicit numeric producer run required'
    def read(suffix):
        result = subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/actions/runs/{run_id}{suffix}'], text=True, timeout=45)
        return json.loads(result)
    run = read('')
    assert run['id'] == int(run_id), 'Producer run identity mismatch'
    artifact_id = validate(run, read('/jobs?per_page=100'), read('/artifacts?per_page=100'),
                           os.environ['CANDIDATE_SOURCE'], os.environ['CANDIDATE_ARTIFACT'])
    print(json.dumps({'producerRunId': run_id, 'artifactId': artifact_id,
                      'sourceCommit': os.environ['CANDIDATE_SOURCE'], 'producerSucceeded': True}))


if __name__ == '__main__':
    main()
