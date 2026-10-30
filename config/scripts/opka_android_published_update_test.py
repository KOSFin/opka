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


if __name__ == '__main__':
    unittest.main()
