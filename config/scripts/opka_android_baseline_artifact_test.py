import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from opka_android_baseline_artifact import verify, PACKAGE, VERSION


class BaselineArtifactTest(unittest.TestCase):
    def test_current_release_baseline_matches_workflow_download(self):
        self.assertEqual(VERSION, '1.4.236-rc.8')
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/opka-android-update-acceptance.yml').read_text()
        self.assertIn(f'gh release download v{VERSION} --repo KOSFin/opka --pattern latest-android.json', workflow)
        self.assertIn("inputs.candidate_version || '1.4.236-rc.9'", workflow)
        self.assertIn('for revision in 7 8; do', workflow)

    def test_release_identity_checksum_and_emulator_abi(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            apk = root / 'opka-android.apk'
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('lib/x86_64/libfixture.so', b'synthetic')
            manifest = {'schemaVersion': 1, 'version': VERSION, 'packageName': PACKAGE,
                        'url': f'https://github.com/KOSFin/opka/releases/download/v{VERSION}/opka-android.apk',
                        'bytes': apk.stat().st_size, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
                        'certificateSha256': 'a' * 64}
            target = root / 'latest-android.json'
            target.write_text(json.dumps(manifest))
            self.assertEqual(verify(root)['version'], VERSION)
            for field, value in [('version', '1.4.236-rc.7'), ('sha256', 'b' * 64),
                                 ('bytes', True), ('packageName', 'com.stably.orca.mobile')]:
                with self.subTest(field=field):
                    target.write_text(json.dumps({**manifest, field: value}))
                    with self.assertRaises(ValueError):
                        verify(root)


if __name__ == '__main__':
    unittest.main()
