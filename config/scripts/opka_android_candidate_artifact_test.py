"""Synthetic APK/provenance fixtures; no Android SDK, credentials or network."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import opka_android_candidate_artifact as candidate


class CandidateArtifactContract(unittest.TestCase):
    def exercise(self, corruption=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            apk = root / 'opka-android.apk'
            apk.write_bytes(b'synthetic signed APK')
            certificate, source, version = 'a' * 64, 'b' * 40, '1.4.236-rc.9'
            manifest = dict(schemaVersion=1, packageName=candidate.PACKAGE, version=version,
                            versionCode=104236009, certificateSha256=certificate,
                            bytes=apk.stat().st_size, sha256=candidate.file_digest(apk),
                            url=f'https://github.com/KOSFin/opka/releases/download/v{version}/opka-android.apk')
            (root / 'latest-android.json').write_text(json.dumps(manifest))
            assets = [dict(name=name, bytes=(root / name).stat().st_size,
                           sha256=candidate.file_digest(root / name)) for name in ('opka-android.apk', 'latest-android.json')]
            provenance = dict(manifest, commit=source, sourceRepository='KOSFin/opka', assets=assets)
            if corruption == 'source':
                provenance['commit'] = 'c' * 40
            if corruption == 'version':
                provenance['version'] = '1.4.236-rc.8'
            if corruption == 'duplicate':
                provenance['assets'].append(assets[0])
            (root / 'opka-android-provenance.json').write_text(json.dumps(provenance))
            if corruption == 'bytes':
                apk.write_bytes(b'tampered')
            def command(*args):
                if args[1] == 'verify':
                    return 'Signer #1 certificate SHA-256 digest: ' + ('c' * 64 if corruption == 'signer' else certificate)
                return {'application-id': candidate.PACKAGE, 'version-name': version,
                        'version-code': '104236009'}[args[2]]
            with patch.object(candidate, 'version_code', return_value=104236009), patch.dict(os.environ, {'ANDROID_HOME': '/synthetic'}), patch.object(candidate.shutil, 'which', return_value='/synthetic/apkanalyzer'):
                proof = candidate.verify(root, version, source, certificate, command)
            self.assertFalse(proof['candidateRebuilt'])
            self.assertEqual(proof['apkSha256'], hashlib.sha256(b'synthetic signed APK').hexdigest())
            self.assertEqual(proof['sourceCommit'], source)
            self.assertEqual(proof['apkBytes'], apk.stat().st_size)

    def test_exact_artifact_is_verified_without_rewriting_payloads(self):
        self.exercise()

    def test_wrong_source_version_payload_signer_and_duplicate_assets_are_refused(self):
        for corruption in ['source', 'version', 'bytes', 'signer', 'duplicate']:
            with self.subTest(corruption=corruption), self.assertRaises(AssertionError):
                self.exercise(corruption)


if __name__ == '__main__':
    unittest.main()
