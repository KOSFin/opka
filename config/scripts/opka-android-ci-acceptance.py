"""Compose updater, idle and real-host UI acceptance on a disposable GitHub emulator."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

from opka_android_candidate_artifact import verify as verify_candidate


class StageSkipped(Exception):
    def __init__(self, reason='stage-prerequisite-failed'):
        self.reason = reason if reason in ('ui-input-unavailable', 'ui-install-failed') else 'stage-prerequisite-failed'
        super().__init__(self.reason)


def safe_failure(error):
    # Exception strings can include private argv, pairing links or subprocess output.
    if isinstance(error, subprocess.TimeoutExpired):
        return 'stage-timeout'
    if isinstance(error, FileNotFoundError):
        return 'stage-dependency-unavailable'
    return 'stage-failed'


def collect_stages(stages, output, device_ready):
    results = []
    unavailable = False
    for name, action in stages:
        if unavailable:
            results.append({'stage': name, 'status': 'skipped', 'reason': 'device-unavailable'})
        elif not device_ready():
            unavailable = True
            results.append({'stage': name, 'status': 'failed', 'reason': 'device-unavailable'})
        else:
            started = time.monotonic()
            try:
                action()
                outcome = {'stage': name, 'status': 'passed'}
            except StageSkipped as error:
                outcome = {'stage': name, 'status': 'skipped', 'reason': error.reason}
            except Exception as error:
                outcome = {'stage': name, 'status': 'failed', 'reason': safe_failure(error)}
            outcome['elapsedSeconds'] = round(time.monotonic() - started, 2)
            results.append(outcome)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'stages': results,
                                      'allPassed': len(results) == len(stages) and all(item['status'] == 'passed' for item in results)}, indent=2) + '\n')
    return results


def run(label, arguments, timeout=720, **options):
    print(label, flush=True)
    process = subprocess.Popen(arguments, start_new_session=True, **options)
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)
        raise
    if code:
        raise RuntimeError(f'{label} failed with exit code {code}')


def device_available(serial):
    try:
        state = subprocess.check_output(['adb', '-s', serial, 'get-state'], text=True, timeout=5,
                                        stderr=subprocess.DEVNULL).strip()
        qemu = subprocess.check_output(['adb', '-s', serial, 'shell', 'getprop', 'ro.kernel.qemu'],
                                       text=True, timeout=5, stderr=subprocess.DEVNULL).strip()
        booted = subprocess.check_output(['adb', '-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
                                         text=True, timeout=5, stderr=subprocess.DEVNULL).strip()
        return state == 'device' and serial.startswith('emulator-') and qemu == '1' and booted == '1'
    except Exception:
        return False


def reset_phase(serial):
    for command in [['shell', 'settings', 'delete', 'global', 'http_proxy'],
                    ['shell', 'am', 'force-stop', 'com.kosfin.opka.mobile'],
                    ['uninstall', 'com.kosfin.opka.mobile']]:
        subprocess.run(['adb', '-s', serial, *command], check=False, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    absent = subprocess.run(['adb', '-s', serial, 'shell', 'pm', 'path', 'com.kosfin.opka.mobile'],
                            check=False, timeout=10, text=True, capture_output=True)
    if absent.returncode not in (0, 1) or absent.stdout.strip() or absent.stderr.strip():
        raise RuntimeError('Could not verify a clean synthetic application reset')


def clear_proxy(serial):
    try:
        subprocess.run(['adb', '-s', serial, 'shell', 'settings', 'delete', 'global', 'http_proxy'],
                       check=False, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def run_ui(serial, candidate, evidence):
    python = sys.executable
    if not Path('out/android-ui-fixture/fixture.mjs').is_file() or not Path(candidate).is_file():
        raise StageSkipped('ui-input-unavailable')
    try:
        run('Install the clean UI candidate', ['adb', '-s', serial, 'install', '--no-streaming', candidate], timeout=180)
    except Exception:
        raise StageSkipped('ui-install-failed') from None
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
                    env={**os.environ, 'CI': 'true'}, timeout=480)
            finally:
                if host.poll() is None:
                    host.terminate()
                    try:
                        host.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        host.kill()
                        host.wait(timeout=10)



def record_webview_environment(serial, target):
    try:
        text = subprocess.check_output(['adb', '-s', serial, 'shell', 'dumpsys', 'webviewupdate'],
                                       text=True, timeout=10, stderr=subprocess.DEVNULL)[:8192]
        provider = re.search(r'Current WebView package[^\n]*?\(([^,()]+),\s*([0-9.]+)\)', text)
        result = {'providerPackage': provider[1].strip(), 'providerVersion': provider[2]} if provider else {'diagnosis': 'provider-unavailable'}
    except (OSError, subprocess.SubprocessError):
        result = {'diagnosis': 'provider-unavailable'}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2) + '\n')


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.name != 'posix':
        raise RuntimeError('This pipeline is restricted to disposable GitHub CI')
    serial = subprocess.check_output(['adb', 'get-serialno'], text=True, timeout=10).strip()
    if not device_available(serial):
        raise RuntimeError('An online disposable emulator is required; physical devices are forbidden')
    record_webview_environment(serial, Path('out/android-native-ui/webview-runtime.json'))
    version = os.environ.get('CANDIDATE_VERSION', '1.4.236-rc.6')
    if not re.fullmatch(r'\d+\.\d+\.\d+-rc\.[1-9]\d*', version):
        raise RuntimeError('Invalid candidate version')
    python = sys.executable
    artifact_directory = os.environ.get('CANDIDATE_ARTIFACT_DIR', '')
    candidate = str(Path(artifact_directory) / 'opka-android.apk') if artifact_directory else 'out/android-update-fixtures/candidate.apk'
    baseline = 'out/android-idle-baseline/opka-android.apk'
    evidence = Path('out/android-native-ui').resolve()
    native = [python, 'config/scripts/opka-android-native-fixture.py',
              '--a', 'out/android-update-fixtures/rc5.apk', '--b', candidate, '--version', version,
              '--apksigner', str(Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner')]
    artifact_proof = None
    if artifact_directory:
        assert os.environ.get('RELEASE_SIGNER') == 'true', 'Built installer acceptance requires protected release scope'
        artifact_proof = verify_candidate(Path(artifact_directory), version, os.environ['GITHUB_SHA'],
                                          os.environ['OPKA_ANDROID_CERTIFICATE_SHA256'].lower())
        native = [python, 'config/scripts/opka-android-native-fixture.py', '--legacy-only',
                  '--legacy-a', baseline, '--b', candidate, '--version', version,
                  '--apksigner', str(Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner')]
    elif os.environ.get('RELEASE_SIGNER') == 'true':
        native += ['--legacy-a', baseline]

    def fresh(action):
        def execute():
            try:
                reset_phase(serial)
                action()
            finally:
                clear_proxy(serial)
        return execute

    stages = [
        ('baseline-idle', fresh(lambda: run('Published baseline and candidate idle measurements',
            [python, 'mobile/scripts/compare-android-idle-performance.py', '--serial', serial,
             '--baseline-apk', baseline, '--candidate-apk', candidate,
             '--output', 'out/android-idle-performance'], timeout=420))),
        ('real-ui', fresh(lambda: run_ui(serial, candidate, evidence))),
        ('native-https', fresh(lambda: run('Production native updater before publication', native, timeout=1200)))
    ]
    if not artifact_directory:
        stages.insert(0, ('os-update', fresh(lambda: run('OS confirmation and retained state',
                      [python, 'config/scripts/opka-android-update-acceptance-entry.py']))))
    results = collect_stages(stages, evidence / 'stage-outcomes.json', lambda: device_available(serial))
    if artifact_proof is not None:
        artifact_proof.update(allPassed=all(item['status'] == 'passed' for item in results), stages=results)
        (evidence / 'candidate-artifact.json').write_text(json.dumps(artifact_proof, indent=2) + '\n')
    ui_passed = any(item['stage'] == 'real-ui' and item['status'] == 'passed' for item in results)
    (evidence / 'pipeline.json').write_text(json.dumps({
        'candidateVersion': version, 'realApk': ui_passed, 'realSyntheticHost': ui_passed,
        'allPassed': all(item['status'] == 'passed' for item in results),
        'physicalBatteryMeasured': False, 'privatePairingMaterialUploaded': False
    }, indent=2) + '\n')
    return 0 if all(item['status'] == 'passed' for item in results) else 1


if __name__ == '__main__':
    sys.exit(main())
