"""Single hosted runner replay; each phase restores the same pristine mobile install."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Disposable hosted CI only'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Hosted runner required'
    root = Path.cwd()
    output = root / 'out/android-gradle-probe'
    output.mkdir(parents=True, exist_ok=True)
    temporary = Path(os.environ['RUNNER_TEMP']) / 'opka-gradle-probe'
    temporary.mkdir(exist_ok=False)
    pristine = temporary / 'mobile.tar'
    with tarfile.open(pristine, 'w') as archive:
        archive.add(root / 'mobile', arcname='mobile')
    receipt = {
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'event': os.environ['GITHUB_EVENT_NAME'],
        'runner': {key: os.environ.get(key) for key in
                   ('RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion', 'JAVA_HOME')},
        'pristineSha256': hashlib.file_digest(pristine.open('rb'), 'sha256').hexdigest(),
        'phases': [],
        'qualification': False,
    }
    try:
        for label, cached, home in [('baseline-cold', False, 'baseline'),
                                     ('candidate-cold', True, 'candidate'),
                                     ('candidate-warm', True, 'candidate'),
                                     ('baseline-warm', False, 'baseline')]:
            shutil.rmtree(root / 'mobile')
            with tarfile.open(pristine) as archive:
                archive.extractall(root, filter='fully_trusted')
            environment = {**os.environ, 'GRADLE_USER_HOME': str(temporary / home),
                           'OPKA_VERSION': '1.4.236-rc.6', 'NODE_OPTIONS': '--max-old-space-size=4096'}
            phase = {'name': label, 'buildCache': cached, 'steps': []}
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
            run('export', ['pnpm', 'exec', 'expo', 'export', '--platform', 'android', '--no-bytecode',
                           '--max-workers', '1', '--output-dir', str(temporary / f'{label}-js')], root / 'mobile')
            run('prebuild', ['pnpm', 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], root / 'mobile')
            flags = ['--build-cache' if cached else '--no-build-cache', '--no-daemon', '--max-workers=1',
                     '-Dorg.gradle.jvmargs=-Xmx2048m', '--console=plain']
            tests = [':opka-app-update:testReleaseUnitTest', ':orca-mobile-web-shell:testReleaseUnitTest']
            tasks = [item for task in tests for item in ([task, '--rerun'] if cached else [task])]
            run('native-tests', ['./gradlew', *tasks, *flags], root / 'mobile/android')
            for artifact, version in [('rc5', '1.4.236-rc.5'), ('candidate', '1.4.236-rc.6')]:
                environment['OPKA_VERSION'] = version
                run(f'{artifact}-prebuild', ['pnpm', 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], root / 'mobile')
                run(f'{artifact}-apk', ['./gradlew', 'assembleRelease', '-PreactNativeArchitectures=x86_64', *flags], root / 'mobile/android')
            phase['gradleHomeBytes'] = sum(p.stat().st_size for p in (temporary / home).rglob('*') if p.is_file())
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    finally:
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
