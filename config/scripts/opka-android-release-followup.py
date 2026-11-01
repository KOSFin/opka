"""Qualify an existing signed release APK without rebuilding or changing its provenance."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

from opka_android_baseline_artifact import verify as verify_baseline
from opka_android_published_update import version_code

SOURCE = '7dd0171c86df322353709f10bde5bb98ceee9d23'
QUALIFIED = '9caaaa70338ef30e9b1ca57f3c72bd4a5402cc03'
RUN = 41326135452
ARTIFACT = 13092296535
VERSION = '1.4.236-rc.8'
DIRECTORY = Path('out/android-release-followup')
DRIVERS = {
    '.github/workflows/opka-android-release-followup.yml',
    'config/scripts/opka-android-native-fixture.py',
    'config/scripts/opka-android-update-acceptance.py',
    'config/scripts/opka_android_handoff_status.py',
    'config/scripts/opka_android_published_update_test.py',
    'config/scripts/opka_android_fixture_proxy_test.py',
    'config/scripts/opka-android-ui-journey.py',
    'config/scripts/opka_android_ui_journey_test.py',
    'config/scripts/opka-android-release-followup.py',
    'mobile/src/host-screen/host-screen-reply-schema.ts',
    'mobile/src/host-screen/use-host-repo-metadata.ts',
    'mobile/src/worktree/project-group-workspace-sections.test.ts',
    'config/scripts/fixtures/android-webview-accessibility/project-hierarchy.xml',
    'config/scripts/fixtures/android-webview-accessibility/title-only.xml',
}


def output(*args):
    return subprocess.check_output(args, text=True, timeout=120).strip()


def api(path):
    return json.loads(output('gh', 'api', f'repos/KOSFin/opka/{path}'))


def verify_inputs():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable GitHub runner required'
    assert os.environ.get('GITHUB_REPOSITORY') == 'KOSFin/opka', 'Unexpected repository'
    head = os.environ.get('GITHUB_SHA', '')
    assert re.fullmatch('[a-f0-9]{40}', head), 'Explicit source SHA required'
    changed = subprocess.check_output(
        ['git', 'diff', '--name-only', '--no-renames', '-z', SOURCE, head, '--'],
        text=True, timeout=120)
    assert all(path in DRIVERS for path in changed.split('\0') if path), 'Only reviewed test/server-web changes are allowed after the signed build'
    subprocess.run(['node', 'config/scripts/opka-release-qualification.mjs'], check=True,
                   env={**os.environ, 'GITHUB_SHA': SOURCE, 'OPKA_QUALIFIED_COMMIT': QUALIFIED})
    run = api(f'actions/runs/{RUN}')
    assert run['head_sha'] == SOURCE and run['path'] == '.github/workflows/opka-release.yml', 'Unexpected build run'
    pages = json.loads(output('gh', 'api', '--paginate', '--slurp',
                             f'repos/KOSFin/opka/actions/runs/{RUN}/jobs?filter=latest&per_page=100'))
    jobs = [job for page in pages for job in page['jobs']]
    assert any(job['head_sha'] == SOURCE and job['run_id'] == RUN and
               job['name'].split(' / ')[-1] == 'Opka Android installer' and
               job['status'] == 'completed' and job['conclusion'] == 'success' for job in jobs), 'Installer did not pass'
    artifact = api(f'actions/artifacts/{ARTIFACT}')
    assert (artifact['name'] == f'opka-android-{SOURCE}' and not artifact['expired'] and
            artifact['workflow_run']['id'] == RUN and artifact['workflow_run']['head_sha'] == SOURCE), 'Unexpected APK artifact'
    provenance = json.loads((DIRECTORY / 'opka-android-provenance.json').read_text())
    manifest = json.loads((DIRECTORY / 'latest-android.json').read_text())
    certificate = os.environ.get('OPKA_ANDROID_CERTIFICATE_SHA256', '').lower()
    assert re.fullmatch('[a-f0-9]{64}', certificate), 'Pinned release certificate required'
    for record in (manifest, provenance):
        assert record['schemaVersion'] == 1 and record['version'] == VERSION
        assert record['packageName'] == 'com.kosfin.opka.mobile' and record['versionCode'] == version_code(VERSION)
        assert record['certificateSha256'] == certificate
    assert provenance['commit'] == SOURCE and provenance['sourceRepository'] == 'KOSFin/opka'
    assert manifest['url'] == f'https://github.com/KOSFin/opka/releases/download/v{VERSION}/opka-android.apk'
    assert {asset['name'] for asset in provenance['assets']} == {'opka-android.apk', 'latest-android.json'}
    for asset in provenance['assets']:
        path = DIRECTORY / asset['name']
        assert 0 < asset['bytes'] <= 512 * 1024**2 and path.stat().st_size == asset['bytes']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == asset['sha256']
    apk = DIRECTORY / 'opka-android.apk'
    assert apk.stat().st_size == manifest['bytes'] and hashlib.sha256(apk.read_bytes()).hexdigest() == manifest['sha256']
    signer = str(Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner')
    analyzer = shutil.which('apkanalyzer')
    assert analyzer, 'Android SDK manifest analyzer required'
    baseline = Path('out/android-idle-baseline')
    assert verify_baseline(baseline)['certificateSha256'].lower() == certificate
    for path in (apk, baseline / 'opka-android.apk'):
        signature = output(signer, 'verify', '--verbose', '--print-certs', str(path))
        assert re.findall(r'Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})', signature, re.I) == [certificate]
        assert 'CN=Android Debug' not in signature
    for field, value in [('application-id', 'com.kosfin.opka.mobile'), ('version-name', VERSION), ('version-code', str(version_code(VERSION)))]:
        assert output(analyzer, 'manifest', field, str(apk)) == value
    (DIRECTORY / 'verified-inputs.json').write_text(json.dumps({'sourceCommit': SOURCE, 'buildRun': RUN,
        'artifactId': ARTIFACT, 'version': VERSION, 'apkSha256': manifest['sha256'],
        'webSourceCommit': head, 'signedApkRebuilt': False}) + '\n')
    return apk, baseline / 'opka-android.apk', signer


def verified_web_manifest():
    subprocess.run(['node', '-e', "require('./config/scripts/verify-packaged-mobile-web-bundle.cjs').assertMobileWebBundleBuilt('out/mobile-web')"], check=True)
    manifest = json.loads(Path('out/mobile-web/manifest.json').read_text())
    assert re.fullmatch('[a-f0-9]{64}', manifest['buildId']), 'Explicit web content build ID required'
    return manifest


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pack_tested_web_patch(proof):
    manifest = verified_web_manifest()
    assert manifest['buildId'] == proof['webBuildId'], 'Web pages changed after acceptance'
    served = json.loads((DIRECTORY / 'ui/host-summary.json').read_text())
    assert served['realHost'] is True and served['mobileWebBuildId'] == proof['webBuildId'], 'Tested host served a different web bundle'
    target = Path('out/mobile-web-release-patch')
    target.mkdir(parents=True, exist_ok=True)
    archive = target / 'opka-mobile-web-rc8.tar.gz'
    root = Path('out/mobile-web')
    with tarfile.open(archive, 'w:gz') as package:
        for name in ['manifest.json', *[asset['path'] for asset in manifest['assets']]]:
            path = root / name
            assert path.is_file() and not path.is_symlink(), 'Only regular declared web assets can be packaged'
            package.add(path, arcname=name, recursive=False)
    provenance = target / 'opka-mobile-web-provenance.json'
    provenance.write_text(json.dumps({'schemaVersion': 1, 'sourceCommit': proof['webSourceCommit'],
        'baseBinarySource': SOURCE, 'version': VERSION, 'buildId': manifest['buildId'],
        'tarSha256': digest(archive), 'tarBytes': archive.stat().st_size,
        'manifestSha256': digest(root / 'manifest.json'), 'testedApkSha256': proof['apkSha256']}, indent=2) + '\n')
    (target / 'opka-mobile-web-SHA256SUMS').write_text(''.join(
        f'{digest(path)}  {path.name}\n' for path in [archive, provenance]))


def main():
    apk, baseline, signer = verify_inputs()
    if '--verify-inputs' in sys.argv:
        return 0
    proof_path = DIRECTORY / 'verified-inputs.json'
    proof = json.loads(proof_path.read_text())
    proof['webBuildId'] = verified_web_manifest()['buildId']
    proof_path.write_text(json.dumps(proof) + '\n')
    spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).with_name('opka-android-ci-acceptance.py'))
    acceptance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(acceptance)
    serial = output('adb', 'get-serialno')
    assert acceptance.device_available(serial), 'Only an online disposable emulator is allowed'
    def fresh(action):
        def execute():
            try:
                acceptance.reset_phase(serial)
                action()
            finally:
                acceptance.clear_proxy(serial)
        return execute
    stages = acceptance.collect_stages([
        ('real-ui', fresh(lambda: acceptance.run_ui(serial, str(apk), DIRECTORY / 'ui'))),
        ('original-rc7-native-update', fresh(lambda: acceptance.run('Original release native update',
            [sys.executable, 'config/scripts/opka-android-native-fixture.py', '--legacy-only',
             '--a', str(baseline), '--b', str(apk), '--legacy-a', str(baseline), '--version', VERSION,
             '--apksigner', signer, '--output', str(DIRECTORY / 'native')], timeout=1200)))
    ], DIRECTORY / 'stage-outcomes.json', lambda: acceptance.device_available(serial))
    if not all(stage['status'] == 'passed' for stage in stages):
        return 1
    pack_tested_web_patch(proof)
    return 0


if __name__ == '__main__':
    sys.exit(main())
