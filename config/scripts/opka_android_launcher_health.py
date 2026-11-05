"""Recover only the captured Pixel Launcher ANR before an installer handoff."""
import re
import time

from opka_android_handoff_status import is_package_resumed, ui_snapshot

PIXEL_HOME = 'com.google.android.apps.nexuslauncher/.NexusLauncherActivity'


def launcher_anr_close_target(tree, home_component):
    nodes = list(tree.iter('node'))
    controls = [node for node in nodes if node.get('resource-id') in (
        'android:id/aerr_close', 'android:id/aerr_wait')]
    if not controls:
        return None
    titles = [node for node in nodes if node.get('resource-id') == 'android:id/alertTitle']
    assert len(titles) == 1 and titles[0].get('package') == 'android' and titles[0].get('text') == "Pixel Launcher isn't responding", 'Unknown or application ANR; refusing recovery'
    assert home_component == PIXEL_HOME, 'Pixel Launcher identity was not verified'
    close = [node for node in controls if node.get('resource-id') == 'android:id/aerr_close']
    assert len(close) == 1 and close[0].get('package') == 'android' and close[0].get('enabled') == 'true' and close[0].get('clickable') == 'true', 'Unverified ANR close control'
    bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', close[0].get('bounds', ''))
    assert bounds, 'Invalid ANR close bounds'
    x1, y1, x2, y2 = map(int, bounds.groups())
    assert x2 > x1 and y2 > y1, 'Empty ANR close bounds'
    return (x1 + x2) // 2, (y1 + y2) // 2


def ensure_pre_handoff_health(shell, screenshot, output, package, now=time.monotonic, pause=time.sleep):
    deadline = now() + 20
    tree, xml = ui_snapshot(shell, '/sdcard/opka-pre-handoff-ui.xml', deadline)
    (output / 'pre-handoff-ui.xml').write_text(xml)
    screenshot('pre-handoff-health')
    has_anr = any(node.get('resource-id') in ('android:id/aerr_close', 'android:id/aerr_wait') for node in tree.iter('node'))
    home = ''
    if has_anr:
        assert shell('getprop', 'ro.kernel.qemu') == '1', 'ANR recovery is emulator-only'
        home = shell('cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME').splitlines()[-1]
        (output / 'pre-handoff-home-component.txt').write_text(home + '\n')
    target = launcher_anr_close_target(tree, home)
    if target is None:
        assert is_package_resumed(shell('dumpsys', 'activity', 'activities'), package), 'Test app is not resumed before handoff'
        return
    shell('input', 'tap', str(target[0]), str(target[1]))
    launch = shell('am', 'start', '-W', '-n', f'{package}/.MainActivity')
    (output / 'pre-handoff-recovery-launch.txt').write_text(launch + '\n')
    assert 'Error:' not in launch and 'Error type' not in launch, 'Test app could not resume after launcher recovery'
    pause(0.25)
    while now() < deadline:
        tree, xml = ui_snapshot(shell, '/sdcard/opka-pre-handoff-ui.xml', deadline)
        (output / 'post-launcher-recovery-ui.xml').write_text(xml)
        screenshot('post-launcher-recovery')
        assert not any(node.get('resource-id') in ('android:id/aerr_close', 'android:id/aerr_wait') for node in tree.iter('node')), 'ANR persisted or recurred after one launcher recovery'
        if is_package_resumed(shell('dumpsys', 'activity', 'activities'), package):
            return
        pause(0.25)
    raise AssertionError('Test app did not resume after one launcher recovery')
