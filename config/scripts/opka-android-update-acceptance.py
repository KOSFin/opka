#!/usr/bin/env python3
"""Exercise same-signer A→B through Android's confirmation UI on an isolated AVD."""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path
import xml.etree.ElementTree as ET

PACKAGE = 'com.kosfin.opka.mobile'


def command(*args, timeout=60):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--a', required=True)
    parser.add_argument('--b', required=True)
    parser.add_argument('--expected-code', type=int, required=True)
    parser.add_argument('--handoff', required=True)
    parser.add_argument('--output', default='out/android-update-acceptance')
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    def adb(*parts, timeout=60):
        return command('adb', *parts, timeout=timeout)

    def shell(*parts):
        return adb('shell', *parts)

    def screenshot(name):
        with (output / f'{name}.png').open('wb') as stream:
            subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=stream, check=True, timeout=30)

    def save_diagnostics():
        for name, parts in [
            ('activities.txt', ['dumpsys', 'activity', 'activities']),
            ('package.txt', ['dumpsys', 'package', PACKAGE]),
            ('crash-logcat.txt', ['logcat', '-d', '-b', 'crash']),
            ('logcat.txt', ['logcat', '-d', '-t', '600']),
            ('uri-grants.txt', ['dumpsys', 'activity', 'permissions'])
        ]:
            try:
                result = subprocess.run(['adb', 'shell', *parts], capture_output=True, text=True, timeout=15)
                (output / name).write_text(result.stdout + result.stderr)
            except Exception as error:
                (output / name).write_text(str(error))
        try:
            shell('uiautomator', 'dump', '/sdcard/opka-update-failure.xml')
            (output / 'final-ui.xml').write_text(shell('cat', '/sdcard/opka-update-failure.xml'))
            screenshot('final-screen')
        except Exception as error:
            (output / 'ui-capture-error.txt').write_text(str(error))

    try:
        assert adb('shell', 'getprop', 'sys.boot_completed') == '1', 'Android has not booted'
        adb('root')
        adb('wait-for-device')
        assert 'Success' in adb('install', '--no-streaming', str(Path(args.a).resolve()), timeout=180)
        shell('input', 'keyevent', 'KEYCODE_WAKEUP')
        shell('wm', 'dismiss-keyguard')
        before = shell('dumpsys', 'package', PACKAGE)
        assert re.search(r'versionCode=104236005\b', before), 'Fixture A version is incorrect'
        uid = re.search(r'userId=(\d+)', before)
        assert uid, 'Installed app UID was not found'
        owner = uid.group(1)
        root = f'/data/user/0/{PACKAGE}'
        marker = 'opka-update-retained-state-v1'
        shell('mkdir', '-p', f'{root}/files', f'{root}/cache/opka-updates')
        shell(f"echo {marker} > {root}/files/update-acceptance-marker")
        shell('chown', '-R', f'{owner}:{owner}', f'{root}/files', f'{root}/cache/opka-updates')
        shell('cmd', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'allow')
        adb('push', str(Path(args.b).resolve()), f'{root}/cache/opka-updates/update.apk')
        shell('chown', f'{owner}:{owner}', f'{root}/cache/opka-updates/update.apk')
        shell('chmod', '600', f'{root}/cache/opka-updates/update.apk')
        shell('restorecon', '-RF', f'{root}/files', f'{root}/cache/opka-updates')
        launch = shell('am', 'start', '-W', '-n', f'{PACKAGE}/.MainActivity')
        (output / 'app-launch.txt').write_text(launch + '\n')
        assert 'Error:' not in launch and 'Error type' not in launch, launch
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            process = subprocess.run(['adb', 'shell', 'pidof', PACKAGE], capture_output=True, text=True, timeout=10)
            activities = shell('dumpsys', 'activity', 'activities')
            if process.returncode == 0 and any(PACKAGE in line and 'mResumedActivity' in line for line in activities.splitlines()):
                break
            time.sleep(1)
        else:
            raise AssertionError('Fixture A did not remain running as the resumed activity')
        screenshot('before-update')
        assert 'Success' in adb('install', '--no-streaming', str(Path(args.handoff).resolve()), timeout=60)
        handoff = shell('am', 'instrument', '-w',
                        'com.kosfin.opka.mobile.acceptance/com.kosfin.opka.mobile.acceptance.UpdateHandoffInstrumentation')
        (output / 'installer-handoff.txt').write_text(handoff + '\n')
        assert 'Error:' not in handoff and 'INSTRUMENTATION_FAILED' not in handoff, handoff
        assert 'handoff=target-app-uid' in handoff, 'Target-app UID handoff was not acknowledged'
        confirmed = False
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            shell('uiautomator', 'dump', '/sdcard/opka-update-ui.xml')
            xml = shell('cat', '/sdcard/opka-update-ui.xml')
            (output / 'last-installer-ui.xml').write_text(xml)
            tree = ET.fromstring(xml)
            for node in tree.iter('node'):
                installer = node.get('package', '')
                if installer not in ('com.android.packageinstaller', 'com.google.android.packageinstaller'):
                    continue
                if node.get('text', '').lower() not in ('install', 'update') or node.get('enabled') != 'true':
                    continue
                bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                if bounds:
                    screenshot('os-confirmation')
                    x1, y1, x2, y2 = map(int, bounds.groups())
                    shell('input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
                    confirmed = True
                    break
            if confirmed:
                break
            time.sleep(1)
        assert confirmed, 'Android installer confirmation was not shown; no silent-install substitute'
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            current = shell('dumpsys', 'package', PACKAGE)
            if re.search(rf'versionCode={args.expected_code}\b', current):
                break
            time.sleep(2)
        else:
            raise AssertionError('Confirmed update did not reach the expected installed version')
        assert shell('cat', f'{root}/files/update-acceptance-marker') == marker, 'App state was lost'
        shell('am', 'force-stop', PACKAGE)
        shell('am', 'start', '-n', f'{PACKAGE}/.MainActivity')
        time.sleep(5)
        assert shell('pidof', PACKAGE), 'Updated app did not restart'
        activities = shell('dumpsys', 'activity', 'activities')
        assert any(PACKAGE in line and 'mResumedActivity' in line for line in activities.splitlines()), 'Updated app is not the resumed activity'
        screenshot('after-update')
        (output / 'receipt.json').write_text(json.dumps({
            'package': PACKAGE, 'installedCode': args.expected_code,
            'osConfirmation': True, 'appFileRetained': True, 'appRestarted': True,
            'scope': 'OS FileProvider handoff; production HTTPS/feed download is a separate gate'
        }, indent=2) + '\n')
    except Exception as error:
        (output / 'failure.txt').write_text(str(error) + '\n' + str(getattr(error, 'output', '')))
        raise
    finally:
        save_diagnostics()


if __name__ == '__main__':
    main()
