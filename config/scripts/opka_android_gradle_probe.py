"""Single hosted runner replay; each phase restores the same pristine mobile install."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import xml.etree.ElementTree as ET
import zipfile


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable hosted CI only'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Hosted runner required'
    root = Path.cwd()
    output = root / 'out/android-gradle-probe'
    output.mkdir(parents=True, exist_ok=True)
    temporary = Path(os.environ['RUNNER_TEMP']) / 'opka-gradle-probe'
    temporary.mkdir(exist_ok=False)
    setup_started = time.monotonic()
    subprocess.run(['sdkmanager', 'ndk;27.1.12297006', 'cmake;3.22.1'], check=True, timeout=600)
    sdk_setup_seconds = round(time.monotonic() - setup_started, 3)
    pristine = temporary / 'mobile.tar'
    with tarfile.open(pristine, 'w') as archive:
        archive.add(root / 'mobile', arcname='mobile')
    receipt = {
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'event': os.environ['GITHUB_EVENT_NAME'],
        'scope': os.environ.get('OPKA_GRADLE_PROBE_SCOPE', 'all'),
        'toolchain': {program: subprocess.run([program, flag], text=True, capture_output=True,
                                            check=True).stdout.strip()
                      for program, flag in [('node', '--version'), ('pnpm', '--version')]},
        'runner': {key: os.environ.get(key) for key in
                   ('RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion', 'JAVA_HOME')},
        'pristineBytes': pristine.stat().st_size,
        'sdkSetupSeconds': sdk_setup_seconds,
        'phases': [],
        'qualification': False,
    }
    receipt['toolchain']['java'] = subprocess.run(['java', '-version'], text=True,
                                                capture_output=True, check=True).stderr.strip()
    receipt['sdkProperties'] = {str(path.relative_to(os.environ['ANDROID_HOME'])):
                                hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in Path(os.environ['ANDROID_HOME']).rglob('source.properties')}
    with pristine.open('rb') as stream:
        receipt['pristineSha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    try:
        for label, cached, home in [('baseline-cold', False, 'baseline'),
                                     ('candidate-cold', True, 'candidate'),
                                     ('candidate-warm', True, 'candidate'),
                                     ('baseline-warm', False, 'baseline')]:
            shutil.rmtree(root / 'mobile')
            with tarfile.open(pristine) as archive:
                archive.extractall(root, filter='fully_trusted')
            metro_temp = temporary / f'{label}-tmp'
            metro_temp.mkdir()
            environment = {**os.environ, 'TMPDIR': str(metro_temp), 'GRADLE_USER_HOME': str(temporary / home),
                           'OPKA_VERSION': '1.4.236-rc.6', 'NODE_OPTIONS': '--max-old-space-size=4096'}
            print(f'Starting {label}', flush=True)
            phase = {'name': label, 'buildCache': cached, 'steps': [], 'tests': [], 'apks': []}
            receipt['phases'].append(phase)
            def run(name, command, cwd):
                started = time.monotonic()
                with (output / f'{label}-{name}.log').open('w') as log:
                    result = subprocess.run(command, cwd=cwd, env=environment,
                                            stdout=log, stderr=subprocess.STDOUT, timeout=1200)
                phase['steps'].append({'name': name, 'seconds': round(time.monotonic() - started, 3),
                                       'exitCode': result.returncode})
                (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                assert result.returncode == 0, f'{label}/{name} failed; inspect retained diagnostics'
            if receipt['scope'] != 'native':
                run('export', ['pnpm', 'exec', 'expo', 'export', '--platform', 'android', '--no-bytecode',
                               '--max-workers', '1', '--output-dir', str(temporary / f'{label}-js')],
                    root / 'mobile')
            run('prebuild', ['pnpm', 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], root / 'mobile')
            flags = ['--build-cache' if cached else '--no-build-cache', '--no-daemon', '--max-workers=1',
                     '-Dorg.gradle.jvmargs=-Xmx2048m', '--console=plain']
            tests = [':opka-app-update:testReleaseUnitTest', ':orca-mobile-web-shell:testReleaseUnitTest']
            tasks = [item for task in tests for item in [task, '--rerun']]
            run('native-tests', ['./gradlew', *tasks, *flags], root / 'mobile/android')
            for xml in (root / 'mobile').rglob('TEST-*.xml'):
                if 'testReleaseUnitTest' not in xml.parts:
                    continue
                suite = ET.parse(xml).getroot()
                relative = xml.relative_to(root / 'mobile')
                phase['tests'].append({'suite': suite.get('name'),
                                       **{key: int(suite.get(key, '0')) for key in
                                          ('tests', 'failures', 'errors', 'skipped')}})
                target = output / label / 'tests' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(xml, target)
            assert sum(suite['tests'] for suite in phase['tests']) > 0, 'Fresh native test XML required'
            assert all(suite['failures'] == suite['errors'] == suite['skipped'] == 0
                       for suite in phase['tests']), 'Every native test must pass'
            variants = [] if receipt['scope'] == 'native' else [
                ('rc5', '1.4.236-rc.5'), ('candidate', '1.4.236-rc.6')]
            for artifact, version in variants:
                environment['OPKA_VERSION'] = version
                run(f'{artifact}-prebuild', ['pnpm', 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], root / 'mobile')
                run(f'{artifact}-apk', ['./gradlew', 'assembleRelease', '-PreactNativeArchitectures=x86_64', *flags], root / 'mobile/android')
                apk = root / 'mobile/android/app/build/outputs/apk/release/app-release.apk'
                with zipfile.ZipFile(apk) as archive:
                    contents = {name: hashlib.sha256(archive.read(name)).hexdigest()
                                for name in archive.namelist() if name in
                                ('AndroidManifest.xml', 'resources.arsc', 'assets/index.android.bundle')
                                or name.startswith('classes') and name.endswith('.dex')
                                or name.startswith('lib/') and name.endswith('.so')}
                analyzer = Path(os.environ['ANDROID_HOME']) / 'cmdline-tools/latest/bin/apkanalyzer'
                identity = {field: subprocess.check_output([str(analyzer), 'manifest', field, str(apk)],
                                                          text=True).strip()
                            for field in ('application-id', 'version-name', 'version-code')}
                assert identity['application-id'] == 'com.kosfin.opka.mobile'
                assert identity['version-name'] == version
                phase['apks'].append({'artifact': artifact, 'identity': identity, 'contents': contents})
            phase['gradleHomeBytes'] = sum(p.stat().st_size for p in (temporary / home).rglob('*') if p.is_file())
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    finally:
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
