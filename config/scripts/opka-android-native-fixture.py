#!/usr/bin/env python3
"""Run both real updater UI paths against signed fixtures, on disposable CI AVD only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time

from opka_android_fixture_proxy import create_server
from opka_android_baseline_artifact import verify as verify_published_baseline
from opka_android_published_update import version_code

PACKAGE = 'com.kosfin.opka.mobile'


def command(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError(f'Command failed: {args[0]}: {result.stdout[-500:]} {result.stderr[-500:]}')
    return result.stdout.strip()


def require_isolated_avd():
    assert os.environ.get('GITHUB_ACTIONS') == 'true', 'Native fixture is restricted to disposable GitHub CI'
    assert command('adb', 'get-serialno').startswith('emulator-'), 'Physical devices are forbidden'
    assert command('adb', 'shell', 'getprop', 'ro.kernel.qemu') == '1', 'Physical devices are forbidden'
    assert command('adb', 'shell', 'getprop', 'ro.debuggable') == '1', 'A rooted test AVD is required'


def certificate(apksigner, apk):
    text = command(apksigner, 'verify', '--print-certs', str(apk))
    matches = re.findall(r'Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})', text)
    assert len(matches) == 1, 'Fixture signer could not be verified'
    return matches[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--a', required=True)
    parser.add_argument('--b', required=True)
    parser.add_argument('--apksigner', required=True)
    parser.add_argument('--version', default='1.4.236-rc.6')
    parser.add_argument('--legacy-a')
    parser.add_argument('--output', default='out/android-native-update-acceptance')
    args = parser.parse_args()
    require_isolated_avd()
    a, b = Path(args.a).resolve(), Path(args.b).resolve()
    signer = certificate(args.apksigner, b)
    assert certificate(args.apksigner, a) == signer, 'A and B must use the same signer'
    assert re.fullmatch(r'\d+\.\d+\.\d+-rc\.[1-9]\d*', args.version), 'Target must be a beta version'
    target_code = version_code(args.version)
    assert target_code > version_code('1.4.236-rc.5'), 'Target must upgrade current-source baseline'
    scenarios = [('home', a, '1.4.236-rc.5', 'home'), ('settings', a, '1.4.236-rc.5', 'settings')]
    if args.legacy_a:
        assert os.environ.get('RELEASE_SIGNER') == 'true', 'Released baseline requires protected release identity'
        legacy = Path(args.legacy_a).resolve()
        assert legacy.name == 'opka-android.apk', 'Use the original unmodified published baseline filename'
        baseline = verify_published_baseline(legacy.parent)
        assert baseline['certificateSha256'].lower() == signer == certificate(args.apksigner, legacy), 'Published baseline signer differs; re-signing is forbidden'
        assert target_code > version_code(baseline['version']), 'Target must upgrade released baseline'
        scenarios.append(('legacy-settings', legacy, baseline['version'], 'settings'))
    digest = hashlib.sha256()
    with b.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    manifest = dict(schemaVersion=1, packageName=PACKAGE, version=args.version,
                    versionCode=target_code, bytes=b.stat().st_size, sha256=digest.hexdigest(),
                    certificateSha256=signer,
                    url=f'https://github.com/KOSFin/opka/releases/download/v{args.version}/opka-android.apk')
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'fixture-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    events = []
    results = []
    event_lock = threading.Lock()

    def record(event):
        with event_lock:
            events.append(event)

    server = None
    ca_path = None
    with tempfile.TemporaryDirectory(prefix='opka-avd-tls-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        temp = Path(directory)
        ca, ca_key = temp / 'ca.pem', temp / 'ca.key'
        leaf, leaf_key, csr = temp / 'leaf.pem', temp / 'leaf.key', temp / 'leaf.csr'
        extensions = temp / 'leaf.ext'
        extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.github.com,DNS:github.com,DNS:release-assets.githubusercontent.com\n')
        command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Opka disposable CI CA', '-keyout', str(ca_key), '-out', str(ca), '-addext', 'basicConstraints=critical,CA:TRUE')
        command('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=github.com', '-keyout', str(leaf_key), '-out', str(csr))
        command('openssl', 'x509', '-req', '-in', str(csr), '-CA', str(ca), '-CAkey', str(ca_key), '-CAcreateserial', '-days', '1', '-out', str(leaf), '-extfile', str(extensions))
        subject_hash = command('openssl', 'x509', '-in', str(ca), '-subject_hash_old', '-noout')
        assert re.fullmatch('[a-f0-9]{8}', subject_hash), 'Invalid temporary CA hash'
        ca_path = f'/system/etc/security/cacerts/{subject_hash}.0'
        try:
            command('adb', 'root')
            command('adb', 'wait-for-device')
            command('adb', 'remount')
            # A read-only/remount failure is a blocked native gate, never a TLS bypass.
            command('adb', 'push', str(ca), ca_path)
            command('adb', 'shell', 'chmod', '644', ca_path)
            command('adb', 'shell', 'restorecon', ca_path)
            server = create_server(('127.0.0.1', 8080), str(leaf), str(leaf_key), manifest, b, record)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            command('adb', 'shell', 'settings', 'put', 'global', 'http_proxy', '10.0.2.2:8080')
            for name, baseline_apk, baseline_version, surface in scenarios:
                command('adb', 'uninstall', PACKAGE, check=False)
                before = len(events)
                environment = {**os.environ, 'OPKA_ANDROID_ISOLATED_FIXTURE': '1'}
                subprocess.run([sys.executable, str(Path(__file__).with_name('opka-android-update-acceptance.py')),
                                '--a', str(baseline_apk), '--a-version', baseline_version, '--published-version', manifest['version'],
                                '--fixture-manifest', str(output / 'fixture-manifest.json'),
                                '--surface', surface, '--output', str(output / name)],
                               env=environment, check=True, timeout=600)
                observed = events[before:]
                assert any(event.startswith('302:github.com:') for event in observed), 'Production native APK redirect was not observed'
                assert '200:release-assets.githubusercontent.com:/opka-ci/opka-android.apk' in observed, 'Production native APK download was not observed'
                results.append({'scenario': name, 'baselineVersion': baseline_version, 'targetVersion': args.version, 'passed': True})
            (output / 'native-fixture-receipt.json').write_text(json.dumps({
                'scenarios': results, 'apkSha256': manifest['sha256'],
                'certificateSha256': signer, 'nativeModuleRecreation': False,
                'network': 'strict isolated HTTPS proxy; production URL and APK checks unchanged',
                'realGithubCandidateCDN': False
            }, indent=2) + '\n')
        finally:
            (output / 'proxy-events.json').write_text(json.dumps(events, indent=2) + '\n')
            (output / 'scenario-results.json').write_text(json.dumps({
                'completed': results, 'requested': [scenario[0] for scenario in scenarios],
                'allPassed': len(results) == len(scenarios),
                'legacyFailureRecovery': 'If released updater cannot open the native installer, preserve failure evidence and require an explicit one-time manual APK update; do not re-sign baseline or mark migration passed.'
            }, indent=2) + '\n')
            command('adb', 'shell', 'settings', 'delete', 'global', 'http_proxy', check=False)
            if ca_path:
                command('adb', 'shell', 'rm', '-f', ca_path, check=False)
            if server:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
