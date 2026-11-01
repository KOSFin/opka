"""Admit the exact installer artifact into Android acceptance without rebuilding it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from opka_android_published_update import version_code

PACKAGE = 'com.kosfin.opka.mobile'


def file_digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(directory, version, source, certificate, command=None):
    command = command or (lambda *args: subprocess.check_output(args, text=True, timeout=90).strip())
    assert re.fullmatch('[a-f0-9]{40}', source), 'Explicit installer source required'
    assert re.fullmatch('[a-f0-9]{64}', certificate), 'Pinned release certificate required'
    code = version_code(version)
    manifest = json.loads((directory / 'latest-android.json').read_text())
    provenance = json.loads((directory / 'opka-android-provenance.json').read_text())
    for record in (manifest, provenance):
        assert record['schemaVersion'] == 1 and record['version'] == version, 'Installer version mismatch'
        assert record['packageName'] == PACKAGE and record['versionCode'] == code, 'Installer package/code mismatch'
        assert record['certificateSha256'] == certificate, 'Installer certificate mismatch'
    assert provenance['commit'] == source and provenance['sourceRepository'] == 'KOSFin/opka', 'Installer source mismatch'
    assert manifest['url'] == f'https://github.com/KOSFin/opka/releases/download/v{version}/opka-android.apk', 'Installer URL mismatch'
    assets = provenance['assets']
    assert len(assets) == 2 and {asset['name'] for asset in assets} == {'opka-android.apk', 'latest-android.json'}, 'Unexpected installer payloads'
    for asset in assets:
        path = directory / asset['name']
        assert path.is_file() and not path.is_symlink(), 'Installer payload must be a regular file'
        assert type(asset['bytes']) is int and 0 < asset['bytes'] <= 512 * 1024**2, 'Invalid installer byte count'
        assert path.stat().st_size == asset['bytes'] and file_digest(path) == asset['sha256'], 'Installer payload checksum mismatch'
    apk = directory / 'opka-android.apk'
    checksum = file_digest(apk)
    assert apk.stat().st_size == manifest['bytes'] and checksum == manifest['sha256'], 'Installer manifest checksum mismatch'
    signer = str(Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner')
    signature = command(signer, 'verify', '--verbose', '--print-certs', str(apk))
    assert re.findall(r'Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})', signature, re.I) == [certificate], 'APK signer differs'
    assert 'CN=Android Debug' not in signature, 'Debug APK cannot be qualified'
    analyzer = shutil.which('apkanalyzer')
    assert analyzer, 'Android manifest analyzer required'
    for field, expected in [('application-id', PACKAGE), ('version-name', version), ('version-code', str(code))]:
        assert command(analyzer, 'manifest', field, str(apk)) == expected, 'APK manifest mismatch'
    return {'schemaVersion': 1, 'sourceCommit': source, 'version': version,
            'versionCode': code, 'packageName': PACKAGE,
            'certificateSha256': certificate, 'apkSha256': checksum,
            'apkBytes': apk.stat().st_size, 'candidateRebuilt': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert os.environ.get('RELEASE_SIGNER') == 'true', 'Built candidate requires protected release scope'
    proof = verify(args.directory, os.environ['CANDIDATE_VERSION'], os.environ.get('CANDIDATE_SOURCE') or os.environ['GITHUB_SHA'],
                   os.environ['OPKA_ANDROID_CERTIFICATE_SHA256'].lower())
    proof['verificationCommit'] = os.environ['GITHUB_SHA']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(proof, indent=2) + '\n')


if __name__ == '__main__':
    main()
