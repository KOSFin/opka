#!/usr/bin/env python3
"""Bounded, reverse-order residency comparison of the exact published rc7/rc8 APKs."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time

_spec = importlib.util.spec_from_file_location('collector', Path(__file__).with_name('capture-android-performance.py'))
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)

PACKAGE = 'com.kosfin.opka.mobile'
INPUTS = {
    'rc7': (132240105, '6296219046af91a89ee7afe1a06a68a35768876585429e71202c8f41a85ff5a6', 104236007),
    'rc8': (132473577, 'b0aa11c19b46c63cc8e7afd4c7542a1e5794676c1386ea7ad1ec71887567883c', 104236008)
}
ORDER = ('rc7', 'rc8', 'rc8', 'rc7')


def verify_apk(path, label):
    size, expected, _ = INPUTS[label]
    if path.stat().st_size != size:
        raise ValueError('Published APK byte size mismatch')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != expected:
        raise ValueError('Published APK digest mismatch')
    return {'bytes': size, 'sha256': digest}


def verify_image(text):
    props = dict(line.strip().split('=', 1) for line in text.splitlines() if '=' in line)
    expected = {'Pkg.Revision': '17', 'AndroidVersion.ApiLevel': '33',
                'SystemImage.TagId': 'google_apis', 'SystemImage.Abi': 'x86_64'}
    if any(props.get(key) != value for key, value in expected.items()):
        raise ValueError('Requires pinned API33 google_apis x86_64 revision17 image')
    return expected


def parse_pressure(text):
    return {match[1]: int(match[2]) for match in
            re.finditer(r'^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$', text, re.M)}


def summarize_mappings(text):
    groups = {}
    current = None
    headers = 0
    for line in text.splitlines():
        header = re.match(r'^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+\d+(?:\s+(.*))?$', line)
        if header:
            headers += 1
            path = header[1] or ''
            # Only classify file mappings; no host/account/path identifiers are retained.
            suffix = re.search(r'\.(apk|dex|odex|oat|art|so)(?:!|\s|$)', path)
            current = suffix[1] if suffix else 'other'
        elif current:
            value = re.match(r'^(Rss|Pss|Private_Clean|Private_Dirty|Swap|SwapPss):\s+(\d+) kB$', line)
            if value:
                bucket = groups.setdefault(current, {})
                bucket[value[1]] = bucket.get(value[1], 0) + int(value[2])
    return {'available': bool(headers), 'groupsKb': groups} if headers else {
        'available': False, 'reason': 'own-smaps-unavailable'}


def require_pid(text):
    if not re.fullmatch(r'[1-9]\d*', text.strip()):
        raise ValueError('Expected exactly one own application PID')
    return text.strip()


def own_activity(text):
    match = re.search(r'(?:mResumedActivity|topResumedActivity).*?\b' + re.escape(PACKAGE) + r'/([^\s}]+)', text)
    return match[1] if match else None


def offline_condition(airplane, wifi, mobile, connectivity):
    match = re.search(r'Active default network:\s*(\S+)', connectivity)
    network = match[1] if match else None
    result = {'airplaneMode': airplane.strip(), 'wifiOn': wifi.strip(),
              'mobileData': mobile.strip(), 'activeDefaultNetwork': network}
    if (result['airplaneMode'], result['wifiOn'], result['mobileData']) != ('1', '0', '0'):
        raise ValueError('Disposable emulator radio settings are not offline')
    if network != 'none':
        raise ValueError('No-default-network evidence is missing or still online')
    return result


def adb_uid(adb):
    try:
        reply = subprocess.run([*adb, 'shell', 'id', '-u'], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, timeout=5, check=False)
        value = reply.stdout.strip()
        return int(value) if reply.returncode == 0 and re.fullmatch(rb'\d{1,10}', value) else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def inspect_adb_access(adb, try_root):
    result = {'requestedRoot': try_root, 'uidBefore': adb_uid(adb),
              'rootCommandCompleted': False, 'waitCompleted': False}
    if try_root:
        try:
            reply = subprocess.run([*adb, 'root'], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=10, check=False)
            result['rootCommandCompleted'] = reply.returncode == 0
            reply = subprocess.run([*adb, 'wait-for-device'], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=10, check=False)
            result['waitCompleted'] = reply.returncode == 0
        except (OSError, subprocess.TimeoutExpired) as error:
            result['unavailableReason'] = type(error).__name__
    result['uidAfter'] = adb_uid(adb)
    result['rootConfirmed'] = result['uidAfter'] == 0
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--rc7-apk', type=Path, required=True)
    parser.add_argument('--rc8-apk', type=Path, required=True)
    parser.add_argument('--system-image-properties', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--try-adb-root', action='store_true',
                        help='Try bounded adb root on the verified disposable emulator for own smaps')
    args = parser.parse_args()
    if os.environ.get('GITHUB_ACTIONS') != 'true' or not args.serial.startswith('emulator-'):
        parser.error('Clean-install comparison requires a disposable GitHub CI emulator')
    image = verify_image(args.system_image_properties.read_text())
    apks = {'rc7': args.rc7_apk, 'rc8': args.rc8_apk}
    evidence = {'schema': 1, 'image': image, 'inputs': {}, 'order': ORDER, 'trials': [],
                'physicalBatteryMeasured': False, 'complete': False}
    adb = ['adb', '-s', args.serial]

    def read(*argv, limit=512_000):
        return collector.run(adb, list(argv), limit=limit)

    def text(*argv):
        result = read(*argv)
        if not result.get('ok'):
            raise RuntimeError('Required app comparison diagnostic unavailable')
        return result['text']

    def command(*argv):
        subprocess.run([*adb, *argv], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=90, check=True)

    def deadline(_signum, _frame):
        raise TimeoutError('Residency comparison exceeded 15 minute hard deadline')

    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(900)
    args.output.mkdir(parents=True, exist_ok=True)
    accepted = False
    try:
        if text('getprop', 'ro.kernel.qemu').strip() != '1':
            raise ValueError('Selected target is not an emulator')
        if text('getprop', 'ro.build.version.sdk').strip() != '33' or text('getprop', 'ro.product.cpu.abi').strip() != 'x86_64':
            raise ValueError('Running emulator does not match the pinned image')
        for label in apks:
            evidence['inputs'][label] = verify_apk(apks[label], label)
        accepted = True
        evidence['adbAccess'] = inspect_adb_access(adb, args.try_adb_root)
        command('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
        command('shell', 'svc', 'wifi', 'disable')
        command('shell', 'svc', 'data', 'disable')
        time.sleep(3)
        for index, label in enumerate(ORDER):
            network = offline_condition(text('settings', 'get', 'global', 'airplane_mode_on'),
                                        text('settings', 'get', 'global', 'wifi_on'),
                                        text('settings', 'get', 'global', 'mobile_data'),
                                        text('dumpsys', 'connectivity'))
            command('uninstall', PACKAGE) if index else subprocess.run(
                [*adb, 'uninstall', PACKAGE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            command('install', '--no-streaming', str(apks[label]))
            package = text('dumpsys', 'package', PACKAGE)
            code = INPUTS[label][2]
            if not re.search(rf'versionCode={code}\b', package) or 'primaryCpuAbi=x86_64' not in package:
                raise ValueError('Installed identity/ABI mismatch')
            command('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
            time.sleep(10)
            pid = require_pid(text('pidof', PACKAGE))
            activity = own_activity(text('dumpsys', 'activity', 'activities'))
            if activity not in ('.MainActivity', PACKAGE + '.MainActivity'):
                raise ValueError('Foreground activity differs from the onboarding baseline')
            trial = {'index': index, 'label': label, 'pid': pid, 'activity': activity,
                     'networkCondition': network,
                     'appUpdateObservation': 'Automatic updater runs unmodified; radio access denied. UI result not inferred.',
                     'packageRuntime': [line.strip() for line in package.splitlines() if re.search(
                         r'versionCode=|versionName=|primaryCpuAbi=|extractNativeLibs=|\[status=|\[reason=|compiler-filter', line)],
                     'samples': []}
            evidence['trials'].append(trial)
            for scenario in ('foreground', 'background'):
                if scenario == 'background':
                    command('shell', 'input', 'keyevent', 'KEYCODE_HOME')
                started = time.monotonic()
                for sample_index in range(4):
                    if require_pid(text('pidof', PACKAGE)) != pid:
                        raise ValueError('Own process restarted; trial is not comparable')
                    resumed = own_activity(text('dumpsys', 'activity', 'activities'))
                    if (resumed == activity) != (scenario == 'foreground'):
                        raise ValueError('Activity visibility does not match the trial phase')
                    sample = collector.snapshot(adb, PACKAGE, time.monotonic() - started)
                    if f'in pid {pid} ' not in sample['memory'].get('text', ''):
                        raise ValueError('meminfo PID differs from selected own process')
                    sample['scenario'] = scenario
                    sample['pressureKb'] = parse_pressure(text('cat', '/proc/meminfo'))
                    sample['oomScoreAdj'] = read('cat', f'/proc/{pid}/oom_score_adj')
                    sample['stat'] = read('cat', f'/proc/{pid}/stat')
                    sample['psi'] = read('cat', '/proc/pressure/memory')
                    smaps = read('cat', f'/proc/{pid}/smaps', limit=4_000_000)
                    sample['mappings'] = summarize_mappings(smaps.get('text', '')) if smaps.get('ok') else {
                        'available': False, 'reason': 'own-smaps-denied-or-bounded'}
                    trial['samples'].append(sample)
                    if sample_index < 3:
                        time.sleep(max(0, (sample_index + 1) * 10 - (time.monotonic() - started)))
        evidence['complete'] = True
    except Exception as error:
        evidence['failureType'] = type(error).__name__
        raise
    finally:
        if accepted:
            try:
                cleanup = subprocess.run([*adb, 'uninstall', PACKAGE], stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, timeout=30)
                evidence['cleanupSucceeded'] = cleanup.returncode == 0
            except subprocess.TimeoutExpired:
                evidence['cleanupSucceeded'] = False
        (args.output / 'residency-comparison.json').write_text(json.dumps(evidence, indent=2))
        signal.alarm(0)


if __name__ == '__main__':
    main()
