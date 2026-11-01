"""Compose updater, idle and real-host UI acceptance on a disposable GitHub emulator."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def run(label, arguments, **options):
    print(label, flush=True)
    result = subprocess.run(arguments, check=False, timeout=1200, **options)
    if result.returncode:
        raise RuntimeError(f'{label} failed with exit code {result.returncode}')


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('This pipeline is restricted to disposable GitHub CI')
    serial = subprocess.check_output(['adb', 'get-serialno'], text=True, timeout=10).strip()
    emulator = subprocess.check_output(['adb', '-s', serial, 'shell', 'getprop', 'ro.kernel.qemu'],
                                       text=True, timeout=10).strip()
    if not serial.startswith('emulator-') or emulator != '1':
        raise RuntimeError('Physical devices are forbidden')
    version = os.environ.get('CANDIDATE_VERSION', '1.4.236-rc.6')
    if not re.fullmatch(r'\d+\.\d+\.\d+-rc\.[1-9]\d*', version):
        raise RuntimeError('Invalid candidate version')
    python = sys.executable
    candidate = 'out/android-update-fixtures/candidate.apk'
    baseline = 'out/android-idle-baseline/opka-android.apk'
    run('OS confirmation and retained state',
        [python, 'config/scripts/opka-android-update-acceptance-entry.py'])
    native = [python, 'config/scripts/opka-android-native-fixture.py',
              '--a', 'out/android-update-fixtures/rc5.apk', '--b', candidate, '--version', version,
              '--apksigner', str(Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner')]
    if os.environ.get('RELEASE_SIGNER') == 'true':
        native += ['--legacy-a', baseline]
    run('Production native updater before publication', native)
    run('Published baseline and candidate idle measurements',
        [python, 'mobile/scripts/compare-android-idle-performance.py', '--serial', serial,
         '--baseline-apk', baseline, '--candidate-apk', candidate,
         '--output', 'out/android-idle-performance'])
    run('Install the clean UI candidate', ['adb', '-s', serial, 'install', '--no-streaming', candidate])
    evidence = Path('out/android-native-ui').resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='opka-ui-private-', dir=os.environ.get('RUNNER_TEMP')) as temporary:
        private = Path(temporary)
        ready = private / 'pairing.json'
        with (private / 'host.log').open('w') as log:
            host = subprocess.Popen(['node', 'out/android-ui-fixture/fixture.mjs',
                                     '--ready-file', str(ready),
                                     '--summary-file', str(evidence / 'host-summary.json')],
                                    env={**os.environ, 'CI': 'true'}, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 120
                while not ready.exists():
                    if host.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('Synthetic host did not become ready; private diagnostics are not uploaded')
                    time.sleep(0.25)
                run('Real APK project and task navigation',
                    [python, 'config/scripts/opka-android-ui-journey.py', '--serial', serial,
                     '--ready-file', str(ready), '--output', str(evidence / 'journey')],
                    env={**os.environ, 'CI': 'true'})
            finally:
                if host.poll() is None:
                    host.terminate()
                    try:
                        host.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        host.kill()
                        host.wait(timeout=10)
    (evidence / 'pipeline.json').write_text(json.dumps({
        'candidateVersion': version, 'realApk': True, 'realSyntheticHost': True,
        'physicalBatteryMeasured': False, 'privatePairingMaterialUploaded': False
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
