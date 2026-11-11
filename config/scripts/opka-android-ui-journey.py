#!/usr/bin/env python3
"""Drive a candidate APK against the real synthetic host, through normal pairing and accessibility."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlsplit, urlunsplit
import xml.etree.ElementTree as ET

from opka_android_handoff_status import ui_snapshot
from opka_android_task_fields import editable_task_field, task_editor_present
from opka_android_target_viewport import find_visible, visible_bounds


def visible_labels(root):
    return {value for node in root.iter('node')
            if node.get('enabled', 'true') == 'true'
            for value in (node.get('text', ''), node.get('content-desc', '')) if value}


def host_list_ready(root):
    return {'Workspace options', 'Accounts', 'Tasks'} <= visible_labels(root)


def onboarding_action(root):
    labels = visible_labels(root)
    if 'Accounts' in labels:
        return 'ready'
    if 'How should sessions open?' in labels and 'Open sessions in Chat UI' in labels:
        return 'Open sessions in Chat UI'
    if 'Don’t miss when an agent needs you' in labels and 'Skip notifications for now' in labels:
        return 'Skip notifications for now'
    return None


def webview_provider_major(text):
    match = re.search(r'Current WebView package[^\n]*?,\s*(\d+)\.', text[:8192])
    return int(match[1]) if match else None


def safe_failure_screen(root):
    # Pair confirmation/error may contain connection credentials; never capture that surface.
    labels = visible_labels(root)
    return ('Pair' not in labels and 'Pair with this desktop?' not in labels
            and (onboarding_action(root) is not None or
                 "This device's WebView is too old to open the workspace safely." in labels))


def label_matches(node, label, contains=False):
    labels = (node.get('text', ''), node.get('content-desc', ''))
    return any(label.casefold() in value.casefold() if contains else label == value for value in labels)


def actionable_match(root, label, contains=False):
    parents = {child: parent for parent in root.iter() for child in parent}
    for node in sorted(root.iter('node'), key=lambda item: item.get('clickable') != 'true'):
        if not label_matches(node, label, contains):
            continue
        candidate = None
        current = node
        while current is not None:
            if current.get('enabled', 'true') != 'true':
                candidate = None
                break
            if candidate is None and current.get('clickable') == 'true':
                candidate = current
            current = parents.get(current)
        if candidate is not None and candidate.get('bounds'):
            return node if node.get('bounds') and visible_bounds(root, node) is None else candidate
    return None



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--ready-file', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--package', default='com.kosfin.opka.mobile')
    args = parser.parse_args()
    if os.environ.get('CI') != 'true' or not args.serial.startswith('emulator-'):
        parser.error('Only an isolated CI emulator is allowed')
    if args.package != 'com.kosfin.opka.mobile':
        parser.error('This journey targets only the separate Opka candidate application')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    adb = ['adb', '-s', args.serial]

    def command(*values, timeout=20, binary=False, raw_errors=False):
        try:
            reply = subprocess.run([*adb, *values], capture_output=True, timeout=timeout, check=True)
        except subprocess.CalledProcessError as error:
            if raw_errors:
                raise
            raise RuntimeError(f'ADB operation failed with exit code {error.returncode}') from None
        except subprocess.TimeoutExpired:
            if raw_errors:
                raise
            raise RuntimeError('ADB operation timed out') from None
        return reply.stdout if binary else reply.stdout.decode(errors='replace')

    if command('shell', 'getprop', 'ro.kernel.qemu').strip() != '1':
        raise AssertionError('Refusing to operate a physical device')
    try:
        provider_major = webview_provider_major(command('shell', 'dumpsys', 'webviewupdate', timeout=10))
    except RuntimeError:
        provider_major = None
    (output / 'webview-provider.json').write_text(json.dumps({
        'providerMajor': provider_major,
        'diagnosis': 'available' if provider_major is not None else 'unavailable'
    }, indent=2))
    fixture = json.loads(Path(args.ready_file).read_text())
    offer = urlsplit(fixture['pairingUrl'])
    if offer.scheme not in ('orca', 'opka') or not offer.query:
        raise AssertionError('Expected the real fixture mobile pairing link')
    # The released Opka manifest owns opka:, while the shared pairing encoder also supports orca:.
    pairing_link = urlunsplit(('opka', offer.netloc, offer.path, offer.query, offer.fragment))
    steps = []
    paired = False

    def tree():
        root, _ = ui_snapshot(lambda *values: command('shell', *values, raw_errors=True),
                              '/sdcard/opka-ui-journey.xml', time.monotonic() + 10)
        return root

    def find(label, timeout=25, contains=False, actionable=False, editable=False, reveal_forward=None):
        def resolve(root):
            if editable:
                return editable_task_field(root, label)
            if actionable:
                return actionable_match(root, label, contains)
            return next((node for node in root.iter('node') if label_matches(node, label, contains)
                         and node.get('enabled', 'true') == 'true'), None)
        return find_visible(tree, resolve, label, timeout,
                            lambda *gesture: command('shell', 'input', 'swipe', *gesture),
                            reveal_forward=reveal_forward, actionable=actionable)

    def tap(label, contains=False, editable=False, reveal_forward=None):
        node = find(label, contains=contains, actionable=True, editable=editable,
                    reveal_forward=reveal_forward)
        numbers = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
        if len(numbers) != 4:
            raise AssertionError(f'No touch bounds for {label!r}')
        command('shell', 'input', 'tap', str((numbers[0] + numbers[2]) // 2),
                str((numbers[1] + numbers[3]) // 2))
        time.sleep(0.25)

    def fill(label, value, replace=False):
        node = find(label, editable=True)
        previous = node.get('text', '')
        tap(label, editable=True)
        if replace:
            if len(previous) > 256:
                raise AssertionError('Refusing an unbounded key sequence')
            command('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
            if previous:
                command('shell', 'input', 'keyevent', *(['KEYCODE_DEL'] * len(previous)))
        command('shell', 'input', 'text', value.replace(' ', '%s'))
        command('shell', 'input', 'keyevent', 'KEYCODE_BACK')

    def wait_for_saved_editor():
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if not task_editor_present(tree()):
                return
            time.sleep(0.35)
        raise AssertionError('Task editor did not close after save')

    def capture(name):
        (output / f'{name}.png').write_bytes(command('exec-out', 'screencap', '-p', binary=True))
        # Only the known synthetic app is in the foreground; snapshots contain no real projects.
        root = tree()
        ET.ElementTree(root).write(output / f'{name}.xml', encoding='utf-8')
        steps.append(name)

    def host_list():
        for _ in range(6):
            root = tree()
            if host_list_ready(root):
                return
            command('shell', 'input', 'keyevent', 'KEYCODE_BACK')
            time.sleep(0.4)
        raise AssertionError('Could not return to synthetic host list')

    collector = subprocess.Popen([
        'python3', str(Path(__file__).resolve().parents[2] / 'mobile/scripts/capture-android-performance.py'),
        '--serial', args.serial, '--package', args.package, '--label', 'candidate-ui',
        '--scenario', 'navigation', '--duration-seconds', '180', '--output', str(output / 'performance')
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        # Do not log the URL: its short-lived token remains in the private fixture file only.
        command('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
                '-d', pairing_link, '-p', args.package)
        tap('Pair')
        # A clean normal pairing presents explicit local onboarding decisions before the host.
        deadline = time.monotonic() + 90
        choices = set()
        while time.monotonic() < deadline:
            action = onboarding_action(tree())
            if action == 'ready':
                break
            if action and action not in choices:
                tap(action)
                choices.add(action)
            else:
                time.sleep(0.35)
        else:
            raise AssertionError('Pairing/onboarding did not reach the synthetic host')
        paired = True
        find('Synthetic integration', contains=True)
        find('client', contains=True)
        find('service', contains=True)
        capture('01-project-hierarchy')
        tap('Collapse project Synthetic integration')
        collapsed = tree()
        if any(label_matches(node, label, contains=True) for node in collapsed.iter('node')
               for label in ('client', 'service')):
            raise AssertionError('Collapsed project still exposes repository children')
        tap('Expand project Synthetic integration')
        find('client', contains=True)
        find('service', contains=True)
        capture('02-project-expand-toggle')
        tap('Accounts')
        tap('Codex pool settings', reveal_forward=True)
        find('Add Codex account', reveal_forward=True)
        capture('03-accounts')
        find('codex pool mode', reveal_forward=True)
        capture('04-pools-expanded')
        find('Add Codex account', reveal_forward=False)
        host_list()
        capture('05-project-return')
        tap('Tasks')
        tap(fixture['projectName'], contains=True)
        find('Native QA starter', contains=True)
        capture('06-board')
        tap('Add project task')
        fill('Task title', 'Native QA new card')
        fill('Task goal', 'Verify candidate card workflow')
        fill('Task acceptance criteria', 'Card is saved and movable')
        capture('07-create-card')
        tap('Save task')
        wait_for_saved_editor()
        tap('Native QA new card', contains=True)
        tap('Edit task')
        fill('Task title', 'Native QA edited card', replace=True)
        tap('Save task')
        wait_for_saved_editor()
        tap('Native QA edited card', contains=True)
        tap('Move task')
        root = tree()
        if any(label_matches(node, 'Done') for node in root.iter('node')):
            raise AssertionError('Move exposed Done instead of requiring result acceptance')
        capture('08-move-card')
        tap('Review')
        find('Add project task')
        find('Native QA edited card', contains=True)
        capture('09-review-board')
        # Normal Back intentionally returns through the catalog; reopen the saved backend card.
        host_list()
        tap('Tasks')
        tap(fixture['projectName'], contains=True)
        find('Native QA edited card', contains=True)
        capture('10-board-reopened')
        report = {'schema': 1, 'steps': steps, 'realCandidateApk': True, 'realSyntheticHost': True,
                  'normalMobilePairing': True, 'credentialsInjected': False,
                  'limits': ['No paid model/provider login was used.',
                             'This native run does not prove populated account quotas or GitLab MR provider integration.',
                             'Emulator CPU/PSS/gfxinfo do not measure physical battery life.']}
        (output / 'journey.json').write_text(json.dumps(report, indent=2))
    except Exception as error:
        (output / 'failure.json').write_text(json.dumps({'steps': steps, 'error': str(error)}, indent=2))
        try:
            if paired or safe_failure_screen(tree()):
                capture('failure')
        except Exception:
            pass
        raise
    finally:
        command('shell', 'rm', '-f', '/sdcard/opka-ui-journey.xml')
        try:
            collector.wait(timeout=190)
        except subprocess.TimeoutExpired:
            collector.terminate()
            collector.wait(timeout=10)
        if collector.returncode != 0:
            raise AssertionError('Android performance collector did not finish successfully')


if __name__ == '__main__':
    main()
