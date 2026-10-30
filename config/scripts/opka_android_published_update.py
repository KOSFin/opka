"""Drive the existing Settings updater; never inject a downloaded APK into the app."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from opka_android_handoff_status import ui_snapshot

PACKAGE = 'com.kosfin.opka.mobile'


def version_code(version):
    env = {**os.environ, 'PUBLISHED_VERSION': version}
    return int(subprocess.check_output([
        'node', '-e', "process.stdout.write(String(require('./mobile/scripts/opka-version-code.cjs')(process.env.PUBLISHED_VERSION)))"
    ], env=env, text=True, timeout=15))


def open_published_update(version, shell, screenshot, output):
    def tree(deadline):
        current, xml = ui_snapshot(shell, '/sdcard/opka-published-ui.xml', deadline)
        (output / 'published-last-ui.xml').write_text(xml)
        return current

    def click(label, stage, timeout=45, scroll=True):
        deadline = time.monotonic() + timeout
        scrolls = 0
        while time.monotonic() < deadline:
            current = tree(deadline)
            for node in current.iter('node'):
                if node.get('package') != PACKAGE or node.get('enabled') != 'true':
                    continue
                labels = [node.get('text', ''), node.get('content-desc', '')]
                if not any(value == label or (label == 'Check for updates' and value.startswith(label + ',')) for value in labels):
                    continue
                bounds = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
                if bounds:
                    screenshot(stage)
                    x1, y1, x2, y2 = map(int, bounds.groups())
                    shell('input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
                    return
            if scroll and scrolls < 4:
                display = shell('wm', 'size')
                width, height = map(int, re.findall(r'(\d+)x(\d+)', display)[-1])
                shell('input', 'swipe', str(width // 2), str(height * 4 // 5), str(width // 2), str(height // 3), '350')
                scrolls += 1
            time.sleep(1)
        raise AssertionError(f'Published update UI action missing: {label}')

    click('Settings', 'published-open-settings')
    click('Check for updates', 'published-check-updates')
    click(f'Update to Orca {version}', 'published-native-download', timeout=90, scroll=False)


def verify_native_download(version, root, adb, output):
    url = f'https://github.com/KOSFin/opka/releases/download/v{version}/latest-android.json'
    with urllib.request.urlopen(url, timeout=45) as response:
        manifest = json.load(response)
    assert manifest['version'] == version and manifest['packageName'] == PACKAGE
    assert manifest['url'] == f'https://github.com/KOSFin/opka/releases/download/v{version}/opka-android.apk'
    with tempfile.TemporaryDirectory(prefix='opka-native-download-') as directory:
        apk = Path(directory) / 'native.apk'
        adb('pull', f'{root}/cache/opka-updates/update.apk', str(apk), timeout=90)
        with apk.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert digest == manifest['sha256'] and apk.stat().st_size == manifest['bytes'], 'Native download differs from public manifest'
        with zipfile.ZipFile(apk) as archive:
            assert any(name.startswith('lib/x86_64/') and name.endswith('.so') for name in archive.namelist()), 'Published APK has no x86_64 ABI for this test'
    (output / 'native-public-download.json').write_text(json.dumps({
        'manifestUrl': url, 'apkUrl': manifest['url'], 'version': version,
        'sha256': digest, 'bytes': manifest['bytes'], 'x86_64': True,
        'certificateSha256': manifest['certificateSha256'],
        'source': 'app-owned cache after existing Settings updater/native installer handoff'
    }, indent=2) + '\n')
