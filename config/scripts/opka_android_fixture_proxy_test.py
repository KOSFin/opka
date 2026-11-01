"""Small offline route and real CONNECT/TLS checks; no Android or external network."""
import hashlib
import http.client
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
import importlib.util
from unittest.mock import patch

from opka_android_fixture_proxy import create_server, fixture_response


class NativeFixtureProxy(unittest.TestCase):
    def test_wrapper_refuses_physical_devices_before_root_or_settings_mutation(self):
        spec = importlib.util.spec_from_file_location('native_fixture', Path(__file__).with_name('opka-android-native-fixture.py'))
        wrapper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(wrapper)
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            return 'physical-device-serial'
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=fake):
            with self.assertRaisesRegex(AssertionError, 'Physical devices'):
                wrapper.require_isolated_avd()
        self.assertEqual(calls, [('adb', 'get-serialno')])

    def test_only_exact_owned_paths_are_served(self):
        manifest = {'version': '1.4.236-rc.6'}
        self.assertEqual(fixture_response('api.github.com', '/repos/KOSFin/opka/git/matching-refs/tags/v', manifest)[0], 200)
        self.assertEqual(fixture_response('github.com', '/KOSFin/opka/releases/download/v1.4.236-rc.6/opka-android.apk', manifest)[0], 302)
        for host, path in [('auth.openai.com', '/'), ('github.com', '/different/repo'),
                           ('api.github.com', '/user'), ('release-assets.githubusercontent.com', '/other.apk')]:
            self.assertEqual(fixture_response(host, path, manifest)[0], 403)

    def test_target_version_is_explicit_and_previous_candidate_paths_are_refused(self):
        manifest = {'version': '1.4.236-rc.8'}
        self.assertEqual(fixture_response('github.com', '/KOSFin/opka/releases/download/v1.4.236-rc.8/latest-android.json', manifest)[0], 200)
        self.assertEqual(fixture_response('github.com', '/KOSFin/opka/releases/download/v1.4.236-rc.6/latest-android.json', manifest)[0], 403)

    def test_real_connect_tls_hostname_validation_and_candidate_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            certificate, key = root / 'cert.pem', root / 'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-subj', '/CN=github.com', '-addext', 'subjectAltName=DNS:github.com,DNS:release-assets.githubusercontent.com',
                            '-keyout', str(key), '-out', str(certificate)], check=True, capture_output=True, timeout=15)
            apk = root / 'signed.apk'
            apk.write_bytes(b'synthetic signed APK bytes')
            events = []
            server = create_server(('127.0.0.1', 0), str(certificate), str(key), {'version': '1.4.236-rc.6'}, apk, events.append)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                context = ssl.create_default_context(cafile=str(certificate))
                client = http.client.HTTPSConnection('127.0.0.1', server.server_port, context=context, timeout=5)
                client.set_tunnel('github.com', 443)
                client.request('GET', '/KOSFin/opka/releases/download/v1.4.236-rc.6/opka-android.apk', headers={'Host': 'github.com'})
                response = client.getresponse()
                self.assertEqual(response.status, 302)
                self.assertEqual(response.getheader('Location'), 'https://release-assets.githubusercontent.com/opka-ci/opka-android.apk')
                response.read()
                client.close()
                client = http.client.HTTPSConnection('127.0.0.1', server.server_port, context=context, timeout=5)
                client.set_tunnel('release-assets.githubusercontent.com', 443)
                client.request('GET', '/opka-ci/opka-android.apk', headers={'Host': 'release-assets.githubusercontent.com'})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(hashlib.sha256(response.read()).digest(), hashlib.sha256(apk.read_bytes()).digest())
                client.close()
                self.assertIn('200:release-assets.githubusercontent.com:/opka-ci/opka-android.apk', events)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
