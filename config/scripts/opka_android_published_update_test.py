"""Offline contract tests: real helper, synthetic ZIP, no ADB and no network."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import opka_android_published_update as updater
from opka_android_handoff_status import completion_action, handoff_ready, ui_snapshot
import subprocess
import xml.etree.ElementTree as ET


class PublishedDownloadContract(unittest.TestCase):
    def exercise(self, bad_hash=False):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            source = output / 'fixture.apk'
            with zipfile.ZipFile(source, 'w') as archive:
                archive.writestr('lib/x86_64/libfixture.so', b'synthetic ABI fixture')
            manifest = {
                'version': '1.4.236-rc.6', 'packageName': 'com.kosfin.opka.mobile',
                'url': 'https://github.com/KOSFin/opka/releases/download/v1.4.236-rc.6/opka-android.apk',
                'bytes': source.stat().st_size,
                'sha256': '0' * 64 if bad_hash else hashlib.sha256(source.read_bytes()).hexdigest(),
                'certificateSha256': 'a' * 64
            }
            calls = []

            def adb(*parts, timeout=60):
                calls.append((parts, timeout))
                self.assertEqual(parts[:2], ('pull', '/synthetic/cache/opka-updates/update.apk'))
                shutil.copyfile(source, parts[2])

            with patch.object(updater.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(manifest).encode())):
                updater.verify_native_download('1.4.236-rc.6', '/synthetic', adb, output)
            self.assertEqual(calls[0][1], 90)
            receipt = json.loads((output / 'native-public-download.json').read_text())
            self.assertTrue(receipt['x86_64'])
            self.assertEqual(receipt['sha256'], manifest['sha256'])

    def test_actual_adb_keyword_contract_and_native_file_receipt(self):
        self.exercise()

    def test_public_manifest_checksum_mismatch_is_rejected(self):
        with self.assertRaisesRegex(AssertionError, 'differs from public manifest'):
            self.exercise(bad_hash=True)


class HandoffProbeContract(unittest.TestCase):
    def test_probe_failure_is_actionable_without_blob_artifacts(self):
        status = 'INSTRUMENTATION_STATUS: probe=failed\nINSTRUMENTATION_STATUS: probeStage=content-resolver-read\nINSTRUMENTATION_STATUS: probeException=FileNotFoundException\n'
        status += 'INSTRUMENTATION_STATUS: probeMessage=Permission denied\nINSTRUMENTATION_STATUS: cacheExists=true\nINSTRUMENTATION_STATUS: cacheBytes=42\n'
        with self.assertRaisesRegex(AssertionError, 'content-resolver-read / FileNotFoundException') as raised:
            handoff_ready(status, 'a' * 64, 42, 104236006)
        self.assertIn('probeMessage=Permission denied', str(raised.exception))
        self.assertIn('cacheExists=true', str(raised.exception))
        self.assertIn('cacheBytes=42', str(raised.exception))

    def test_acknowledgement_requires_all_exact_read_and_archive_facts(self):
        fields = dict(probe='passed', handoff='target-app-uid', uid='10130', targetUid='10130',
                      sha256='a' * 64, bytes='42', archiveVersion='104236006',
                      archivePackage='com.kosfin.opka.mobile')
        status = ''.join(f'INSTRUMENTATION_STATUS: {key}={value}\n' for key, value in fields.items())
        self.assertTrue(handoff_ready(status, 'a' * 64, 42, 104236006))
        self.assertFalse(handoff_ready(status, 'b' * 64, 42, 104236006))
        self.assertFalse(handoff_ready(status.replace('targetUid=10130', 'targetUid=0'), 'a' * 64, 42, 104236006))


class InstallerUiTransitionContract(unittest.TestCase):
    def test_dump_missing_file_and_transient_xml_are_retried_without_stale_reads(self):
        attempts = 0
        removals = 0
        clock = iter(range(20))

        def shell(*parts):
            nonlocal attempts, removals
            if parts[0] == 'rm':
                removals += 1
                return ''
            if parts[0] == 'uiautomator':
                attempts += 1
                return '' if attempts == 1 else 'UI hierchary dumped to: /synthetic.xml'
            self.assertEqual(parts, ('cat', '/synthetic.xml'))
            if attempts == 2:
                raise subprocess.CalledProcessError(1, 'cat', 'No such file')
            return '<broken' if attempts == 3 else '<hierarchy><node text="Install" /></hierarchy>'

        tree, _ = ui_snapshot(shell, '/synthetic.xml', 10, now=lambda: next(clock), pause=lambda _: None)
        self.assertEqual(tree.find('node').get('text'), 'Install')
        self.assertEqual(removals, 4)
        self.assertEqual(attempts, 4)

    def test_ui_snapshot_has_an_overall_deadline(self):
        clock = iter(range(20))
        with self.assertRaisesRegex(TimeoutError, 'No fresh Android UI snapshot'):
            ui_snapshot(lambda *args: '', '/synthetic.xml', 3,
                        now=lambda: next(clock), pause=lambda _: None)

    def test_old_instrumentation_exit_and_os_completion_precede_open_and_stable_resume(self):
        installing = ET.fromstring('<hierarchy><node package="com.android.packageinstaller" text="Installing…" /></hierarchy>')
        installed = ET.fromstring('<hierarchy><node package="com.android.packageinstaller" text="Open" enabled="true" /></hierarchy>')
        target = ET.fromstring('<hierarchy><node package="com.kosfin.opka.mobile" text="Settings" /></hierarchy>')
        self.assertEqual(completion_action(False, installed, False, 0), ('wait', 0))
        self.assertEqual(completion_action(False, target, True, 0), ('wait', 0))
        self.assertEqual(completion_action(True, installing, False, 0), ('wait', 0))
        self.assertEqual(completion_action(True, installing, True, 1), ('wait', 0))
        self.assertEqual(completion_action(True, installed, False, 0), ('open', 0))
        self.assertEqual(completion_action(True, target, True, 0), ('wait', 1))
        self.assertEqual(completion_action(True, target, True, 1), ('ready', 2))
        self.assertEqual(completion_action(True, installing, False, 1), ('wait', 0))


if __name__ == '__main__':
    unittest.main()
