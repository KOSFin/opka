"""Verify the published idle baseline before installing it on a CI emulator."""
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

VERSION = '1.4.236-rc.8'
PACKAGE = 'com.kosfin.opka.mobile'


def verify(directory):
    manifest = json.loads((directory / 'latest-android.json').read_text())
    if (manifest.get('schemaVersion') != 1 or manifest.get('version') != VERSION or
            manifest.get('packageName') != PACKAGE or
            manifest.get('url') != f'https://github.com/KOSFin/opka/releases/download/v{VERSION}/opka-android.apk' or
            type(manifest.get('bytes')) is not int or not 1 <= manifest['bytes'] <= 512 * 1024**2 or
            not re.fullmatch('[a-f0-9]{64}', str(manifest.get('sha256', ''))) or
            not re.fullmatch('[a-fA-F0-9]{64}', str(manifest.get('certificateSha256', '')))):
        raise ValueError('Published Android baseline identity is invalid')
    apk = directory / 'opka-android.apk'
    digest = hashlib.sha256()
    with apk.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    if apk.stat().st_size != manifest['bytes'] or digest.hexdigest() != manifest['sha256']:
        raise ValueError('Published Android baseline checksum is invalid')
    with zipfile.ZipFile(apk) as archive:
        if not any(name.startswith('lib/x86_64/') and name.endswith('.so') for name in archive.namelist()):
            raise ValueError('Published Android baseline lacks emulator ABI')
    return manifest


if __name__ == '__main__':
    verified = verify(Path(sys.argv[1]))
    print(verified['certificateSha256'].lower())
