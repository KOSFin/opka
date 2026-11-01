#!/usr/bin/env python3
"""Compare clean-install onboarding idle only, on an explicitly selected CI emulator."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

PACKAGE = 'com.kosfin.opka.mobile'


def command(argv, timeout=45):
    result = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=timeout)
    if result.returncode:
        raise RuntimeError('Android comparison command failed; no device output archived')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--baseline-apk', required=True)
    parser.add_argument('--candidate-apk', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        parser.error('Destructive clean-install comparison is restricted to disposable GitHub CI')
    adb = ['adb', '-s', args.serial]
    reply = subprocess.run([*adb, 'shell', 'getprop', 'ro.kernel.qemu'],
                           capture_output=True, timeout=10)
    if reply.returncode or reply.stdout.strip() != b'1' or not args.serial.startswith('emulator-'):
        parser.error('Only an explicitly selected Android emulator is accepted')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    evidence = {'scope': 'clean-install onboarding idle; no paired host or account',
                'physicalBatteryMeasured': False, 'inputs': []}
    try:
        for label, apk in [('published-rc7', args.baseline_apk), ('candidate', args.candidate_apk)]:
            artifact = Path(apk)
            if not artifact.is_file():
                parser.error('Both APK inputs must exist')
            with artifact.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            # Different signing identities are expected; do not upgrade across them.
            subprocess.run([*adb, 'uninstall', PACKAGE], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
            command([*adb, 'install', '--no-streaming', str(artifact)], timeout=90)
            command([*adb, 'shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/.MainActivity'])
            time.sleep(10)
            evidence['inputs'].append({'label': label, 'sha256': digest})
            for scenario in ['idle-foreground', 'idle-background']:
                if scenario == 'idle-background':
                    command([*adb, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'])
                command([sys.executable, str(Path(__file__).with_name('capture-android-performance.py')),
                         '--serial', args.serial, '--label', label, '--scenario', scenario,
                         '--duration-seconds', '60', '--output', str(output / label / scenario)], timeout=150)
    finally:
        subprocess.run([*adb, 'uninstall', PACKAGE], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
        (output / 'comparison-inputs.json').write_text(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
