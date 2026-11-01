"""Small offline route and real CONNECT/TLS checks; no Android or external network."""
from contextlib import nullcontext
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


def load_native_fixture():
    spec = importlib.util.spec_from_file_location('native_fixture', Path(__file__).with_name('opka-android-native-fixture.py'))
    wrapper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wrapper)
    return wrapper


class NativeFixtureProxy(unittest.TestCase):
    def test_wrapper_refuses_physical_devices_before_root_or_settings_mutation(self):
        wrapper = load_native_fixture()
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



class DisposableAvdTrust(unittest.TestCase):
    def fake_device(self, writable, kernel='1', debuggable='1', serial='emulator-5554', sdk='30'):
        calls, probes = [], []
        def fake(*args, **kwargs):
            calls.append(args)
            if args == ('adb', 'get-serialno'):
                return serial
            operation = args[3:]
            if operation == ('shell', 'getprop', 'ro.kernel.qemu'):
                return kernel
            if operation == ('shell', 'getprop', 'ro.debuggable'):
                return debuggable
            if operation == ('shell', 'getprop', 'ro.build.version.sdk'):
                return sdk
            if operation[:3] == ('shell', 'ls', '-Zd'):
                return 'u:object_r:system_file:s0 /system/etc/security/cacerts'
            if operation and operation[0] == 'shell' and 'echo OPKA_CA_WRITABLE' in operation[-1]:
                result = writable[min(len(probes), len(writable) - 1)]
                probes.append(result)
                return 'OPKA_CA_WRITABLE' if result else ''
            return ''
        return fake, calls, probes

    def test_all_safety_gates_precede_privileged_mutations(self):
        for environment, values in [({'GITHUB_ACTIONS': 'false'}, {}),
                                    ({'GITHUB_ACTIONS': 'true'}, {'serial': 'physical-device'}),
                                    ({'GITHUB_ACTIONS': 'true'}, {'kernel': '0'}),
                                    ({'GITHUB_ACTIONS': 'true'}, {'debuggable': '0'})]:
            wrapper = load_native_fixture()
            fake, calls, _ = self.fake_device([True], **values)
            with patch.dict(wrapper.os.environ, environment), patch.object(wrapper, 'command', side_effect=fake):
                with self.assertRaises(AssertionError):
                    with wrapper.prepare_writable_system_ca_store():
                        pass
            self.assertFalse(any('root' in call or 'disable-verity' in call or 'reboot' in call for call in calls))

    def test_writable_fast_path_does_not_reboot_or_disable_verity(self):
        wrapper = load_native_fixture()
        fake, calls, probes = self.fake_device([True])
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=fake):
            with wrapper.prepare_writable_system_ca_store() as serial:
                self.assertEqual(serial, 'emulator-5554')
        self.assertEqual(probes, [True])
        self.assertFalse(any('disable-verity' in call or 'reboot' in call for call in calls))
        root_calls = [call for call in calls if len(call) > 3 and call[3] in ('root', 'remount')]
        self.assertEqual(root_calls, [('adb', '-s', 'emulator-5554', 'root')])

    def test_readonly_store_uses_copy_and_bind_without_reboot(self):
        wrapper = load_native_fixture()
        fake, calls, probes = self.fake_device([False, True])
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=fake):
            with wrapper.prepare_writable_system_ca_store() as serial:
                self.assertEqual(serial, 'emulator-5554')
        self.assertFalse(any('disable-verity' in call or 'reboot' in call or 'remount' in call for call in calls))
        copy = next(i for i, call in enumerate(calls) if len(call) > 4 and call[4] == 'cp')
        mount = next(i for i, call in enumerate(calls) if len(call) > 4 and call[4] == 'mount')
        self.assertLess(copy, mount)
        self.assertTrue(any('chcon' in call and 'u:object_r:system_file:s0' in call for call in calls))
        self.assertTrue(any('umount' in call for call in calls))
        self.assertEqual(probes, [False, True])

    def test_existing_overlay_is_preserved_when_mkdir_refuses_collision(self):
        wrapper = load_native_fixture()
        fake, calls, _ = self.fake_device([False])
        def collision(*args, **kwargs):
            result = fake(*args, **kwargs)
            if args[3:5] == ('shell', 'mkdir'):
                raise RuntimeError('existing overlay collision')
            return result
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=collision):
            with self.assertRaisesRegex(RuntimeError, 'existing overlay collision'):
                with wrapper.prepare_writable_system_ca_store():
                    pass
        self.assertFalse(any('mount' in call or 'cp' in call or '-rf' in call for call in calls))

    def test_body_failure_unmounts_owned_overlay_and_preserves_original_error(self):
        wrapper = load_native_fixture()
        fake, calls, _ = self.fake_device([False, True])
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=fake):
            with self.assertRaisesRegex(ValueError, 'original scenario failure'):
                with wrapper.prepare_writable_system_ca_store():
                    raise ValueError('original scenario failure')
        self.assertEqual(calls[-3][3:], ('shell', 'am', 'force-stop', 'com.kosfin.opka.mobile'))
        self.assertEqual(calls[-2][3:], ('shell', 'umount', '/system/etc/security/cacerts'))
        self.assertEqual(calls[-1][3:6], ('shell', 'rm', '-rf'))
        self.assertTrue(calls[-1][-1].startswith('/data/local/tmp/opka-ci-cacerts-'))

    def test_still_readonly_fails_without_pushing_a_certificate(self):
        wrapper = load_native_fixture()
        fake, calls, _ = self.fake_device([False])
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=fake):
            with self.assertRaisesRegex(RuntimeError, 'not writable'):
                with wrapper.prepare_writable_system_ca_store():
                    pass
        self.assertFalse(any(len(call) > 3 and call[3] == 'push' for call in calls))
        self.assertTrue(any('umount' in call for call in calls))
        self.assertTrue(calls[-1][-1].startswith('/data/local/tmp/opka-ci-cacerts-'))

    def test_unsupported_sdk_refuses_overlay_without_mutating_trust(self):
        wrapper = load_native_fixture()
        fake, calls, _ = self.fake_device([False], sdk='34')
        with patch.dict(wrapper.os.environ, {'GITHUB_ACTIONS': 'true'}), patch.object(wrapper, 'command', side_effect=fake):
            with self.assertRaisesRegex(AssertionError, 'API30'):
                with wrapper.prepare_writable_system_ca_store():
                    pass
        self.assertFalse(any('mount' in call or 'cp' in call for call in calls))

    def test_overlay_failure_attempts_proxy_cleanup_without_removing_unowned_ca(self):
        wrapper = load_native_fixture()
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args[0] == 'openssl' and '-subject_hash_old' in args:
                return 'abcdef01'
            if args[:4] == ('adb', '-s', 'emulator-5554', 'shell') and 'settings' in args:
                raise subprocess.TimeoutExpired('adb', 10)
            return ''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = root / 'a.apk', root / 'b.apk'
            a.write_bytes(b'a')
            b.write_bytes(b'b')
            argv = ['fixture', '--a', str(a), '--b', str(b), '--apksigner', 'fake', '--output', str(root / 'output')]
            with patch.object(wrapper.sys, 'argv', argv), patch.object(wrapper, 'require_isolated_avd', return_value='emulator-5554'), patch.object(wrapper, 'certificate', return_value='a' * 64), patch.object(wrapper, 'version_code', side_effect=lambda version: 6 if version.endswith('.6') else 5), patch.object(wrapper, 'command', side_effect=fake), patch.object(wrapper, 'prepare_writable_system_ca_store', side_effect=RuntimeError('overlay setup')):
                with self.assertRaisesRegex(RuntimeError, 'overlay setup'):
                    wrapper.main()
        self.assertFalse(any('rm' in call and '/system/etc/security/cacerts/abcdef01.0' in call for call in calls))


    def test_existing_ca_is_preserved_and_refused_before_push(self):
        wrapper = load_native_fixture()
        calls = []
        def fake(*args, **kwargs):
            calls.append(args)
            if args[0] == 'openssl' and '-subject_hash_old' in args:
                return 'abcdef01'
            if args[3:7] == ('shell', 'test', '!', '-e'):
                raise RuntimeError('existing CA collision')
            return ''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            a, b = root / 'a.apk', root / 'b.apk'
            a.write_bytes(b'a')
            b.write_bytes(b'b')
            argv = ['fixture', '--a', str(a), '--b', str(b), '--apksigner', 'fake', '--output', str(root / 'output')]
            with patch.object(wrapper.sys, 'argv', argv), patch.object(wrapper, 'require_isolated_avd', return_value='emulator-5554'), patch.object(wrapper, 'certificate', return_value='a' * 64), patch.object(wrapper, 'version_code', side_effect=lambda version: 6 if version.endswith('.6') else 5), patch.object(wrapper, 'command', side_effect=fake), patch.object(wrapper, 'prepare_writable_system_ca_store', return_value=nullcontext('emulator-5554')):
                with self.assertRaisesRegex(RuntimeError, 'existing CA collision'):
                    wrapper.main()
        self.assertFalse(any(len(call) > 3 and call[3] == 'push' for call in calls))
        self.assertFalse(any('rm' in call and '/system/etc/security/cacerts/abcdef01.0' in call for call in calls))

if __name__ == '__main__':
    unittest.main()
