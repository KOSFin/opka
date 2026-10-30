#!/usr/bin/env python3
"""Exercise same-signer A→B through Android's confirmation UI on an isolated AVD."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
import xml.etree.ElementTree as ET

from opka_android_handoff_status import handoff_ready
from opka_android_published_update import open_published_update, verify_native_download, version_code

PACKAGE = 'com.kosfin.opka.mobile'


def command(*args, timeout=60):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--a', required=True)
    parser.add_argument('--b')
    parser.add_argument('--expected-code', type=int)
    parser.add_argument('--handoff')
    parser.add_argument('--published-version', default='')
    parser.add_argument('--output', default='out/android-update-acceptance')
    args = parser.parse_args()
    if args.published_version:
        assert os.environ.get('RELEASE_SIGNER') == 'true', 'Published-channel acceptance requires the protected release signer'
        args.expected_code = version_code(args.published_version)
        assert args.expected_code > 104236005, 'Published version must upgrade fixture A'
    else:
        assert args.b and args.handoff and args.expected_code, 'Fixture B, handoff and expected code are required'
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    def adb(*parts, timeout=60):
        return command('adb', *parts, timeout=timeout)

    def shell(*parts):
        return adb('shell', *parts)

    def screenshot(name):
        with (output / f'{name}.png').open('wb') as stream:
            subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=stream, check=True, timeout=30)

    handoff_process = None
    handoff_stream = None

    def save_diagnostics():
        for name, parts in [
            ('activities.txt', ['dumpsys', 'activity', 'activities']),
            ('package.txt', ['dumpsys', 'package', PACKAGE]),
            ('crash-logcat.txt', ['logcat', '-d', '-b', 'crash']),
            ('logcat.txt', ['logcat', '-d', '-t', '5000']),
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
        if args.published_version:
            shell('test', '!', '-e', f'{root}/cache/opka-updates/update.apk')
        if not args.published_version:
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
        if args.published_version:
            open_published_update(args.published_version, shell, screenshot, output)
        else:
            assert 'Success' in adb('install', '--no-streaming', str(Path(args.handoff).resolve()), timeout=60)
            digest = hashlib.sha256()
            with Path(args.b).open('rb') as stream:
                for chunk in iter(lambda: stream.read(65536), b''):
                    digest.update(chunk)
            expected_hash = digest.hexdigest()
            expected_bytes = Path(args.b).stat().st_size
            handoff_log = output / 'installer-handoff.txt'
            handoff_stream = handoff_log.open('w')
            handoff_process = subprocess.Popen([
                'adb', 'shell', 'am', 'instrument', '-w',
                '-e', 'expected_sha256', expected_hash,
                '-e', 'expected_bytes', str(expected_bytes),
                '-e', 'expected_code', str(args.expected_code),
                'com.kosfin.opka.mobile.acceptance/com.kosfin.opka.mobile.acceptance.UpdateHandoffInstrumentation'
            ], stdout=handoff_stream, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                handoff = handoff_log.read_text()
                if handoff_ready(handoff, expected_hash, expected_bytes, args.expected_code):
                    break
                assert handoff_process.poll() is None, handoff
                time.sleep(0.25)
            else:
                raise AssertionError('Target-app UID/readable APK probe was not acknowledged')
            (output / 'post-handoff-uri-grants.txt').write_text(shell('dumpsys', 'activity', 'permissions'))
        confirmed = False
        last_ui = []
        deadline = time.monotonic() + (300 if args.published_version else 120)
        while time.monotonic() < deadline:
            if handoff_process is not None:
                assert handoff_process.poll() is None, 'Instrumentation exited before OS confirmation; URI grant may have been revoked'
            shell('uiautomator', 'dump', '/sdcard/opka-update-ui.xml')
            xml = shell('cat', '/sdcard/opka-update-ui.xml')
            (output / 'last-installer-ui.xml').write_text(xml)
            tree = ET.fromstring(xml)
            last_ui = list(dict.fromkeys(re.sub(r'\s+', ' ', node.get('text', ''))[:100] for node in tree.iter('node') if node.get('text')))[:10]
            if args.published_version and any(node.get('text') == 'Update could not be opened' for node in tree.iter('node')):
                raise AssertionError('Production native update failed; inspect last-installer-ui.xml')
            for node in tree.iter('node'):
                installer = node.get('package', '')
                if installer not in ('com.android.packageinstaller', 'com.google.android.packageinstaller'):
                    continue
                if node.get('text', '').lower() not in ('install', 'update') or node.get('enabled') != 'true':
                    continue
                bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                if bounds:
                    screenshot('os-confirmation')
                    if args.published_version:
                        verify_native_download(args.published_version, root, adb, output)
                    x1, y1, x2, y2 = map(int, bounds.groups())
                    shell('input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
                    confirmed = True
                    break
            if confirmed:
                break
            time.sleep(1)
        assert confirmed, 'Android installer confirmation was not shown; no silent-install substitute; UI=' + ' | '.join(last_ui)
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
            'scope': 'public Settings feed/native download/hash/signer/OS confirmation' if args.published_version else 'OS FileProvider handoff; production HTTPS/feed download is a separate gate',
            'publishedVersion': args.published_version or None
        }, indent=2) + '\n')
    except Exception as error:
        (output / 'failure.txt').write_text(str(error) + '\n' + str(getattr(error, 'output', '')))
        message = re.sub(r'https://\S+', '[URL]', str(error))[:1500]
        message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print(f'::error title=Android update acceptance::{type(error).__name__}: {message}', flush=True)
        raise
    finally:
        save_diagnostics()
        if handoff_process is not None and handoff_process.poll() is None:
            try:
                subprocess.run(['adb', 'shell', 'am', 'force-stop', PACKAGE], capture_output=True, timeout=15)
            except subprocess.TimeoutExpired as error:
                (output / 'cleanup-error.txt').write_text(str(error))
            handoff_process.terminate()
            try:
                handoff_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                handoff_process.kill()
                handoff_process.wait(timeout=5)
        if handoff_stream is not None:
            handoff_stream.close()


if __name__ == '__main__':
    main()
