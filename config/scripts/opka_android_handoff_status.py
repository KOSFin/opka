"""Decode bounded diagnostic evidence from the CI-only target-UID probe."""
import re


def handoff_ready(text, expected_hash, expected_bytes, expected_code):
    fields = dict(re.findall(r'^INSTRUMENTATION_(?:STATUS|RESULT): ([A-Za-z0-9]+)=([^\r\n]*)', text, re.MULTILINE))
    if fields.get('probe') == 'failed':
        details = ', '.join(
            f'{key}={fields[key][:limit]}' for key, limit in [
                ('probeMessage', 180), ('cacheExists', 8), ('cacheCanRead', 8),
                ('cacheBytes', 24), ('bytes', 24), ('expectedBytes', 24),
                ('archivePackage', 100), ('archiveVersion', 24), ('expectedCode', 24)
            ] if key in fields
        )
        raise AssertionError(f"APK probe failed: {fields.get('probeStage', 'unknown')[:80]} / {fields.get('probeException', 'unknown')[:80]}; {details}")
    return (
        fields.get('handoff') == 'target-app-uid' and fields.get('probe') == 'passed'
        and fields.get('sha256') == expected_hash and fields.get('bytes') == str(expected_bytes)
        and fields.get('archiveVersion') == str(expected_code)
        and fields.get('archivePackage') == 'com.kosfin.opka.mobile'
        and fields.get('uid') is not None and fields.get('uid') == fields.get('targetUid')
    )


def ui_snapshot(shell, path, deadline, now=None, pause=None):
    import subprocess
    import time
    import xml.etree.ElementTree as ET
    now = now or time.monotonic
    pause = pause or time.sleep
    last_error = 'no snapshot'
    while now() < deadline:
        try:
            shell('rm', '-f', path)
            result = shell('uiautomator', 'dump', path)
            if ' dumped to:' not in result:
                raise ValueError(result[-160:] or 'dump returned no hierarchy path')
            xml = shell('cat', path)
            tree = ET.fromstring(xml)
            if tree.tag != 'hierarchy' or next(tree.iter('node'), None) is None:
                raise ValueError('empty UI hierarchy during transition')
            return tree, xml
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ET.ParseError, ValueError) as error:
            last_error = str(error)[-200:]
            pause(0.25)
    raise TimeoutError(f'No fresh Android UI snapshot before deadline: {last_error}')


def completion_action(instrumentation_done, tree, target_resumed, stable_count):
    if not instrumentation_done:
        return 'wait', 0
    installers = [node for node in tree.iter('node') if node.get('package') in (
        'com.android.packageinstaller', 'com.google.android.packageinstaller')]
    if target_resumed and not installers:
        count = stable_count + 1
        return ('ready' if count >= 2 else 'wait'), count
    if any(node.get('text', '').lower() == 'open' and node.get('enabled') == 'true' for node in installers):
        return 'open', 0
    if any(node.get('text', '').lower().rstrip('.') in ('app installed', 'done') for node in installers):
        return 'launch', 0
    return 'wait', 0
