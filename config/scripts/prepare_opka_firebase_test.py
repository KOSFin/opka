"""Offline fixtures only; never load the operator's Firebase input."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'prepare_opka_firebase', Path(__file__).with_name('prepare-opka-firebase.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(package='com.kosfin.opka.mobile'):
    return json.dumps({'project_info': {'project_id': 'fixture', 'project_number': '1'},
                       'client': [{'client_info': {'mobilesdk_app_id': 'fixture-app',
                                  'android_client_info': {'package_name': package}}}]})


class FirebaseBuildInputTest(unittest.TestCase):
    def test_rejects_upstream_package_and_malformed_input_without_contents(self):
        for raw in [fixture('com.stably.orca.mobile'), 'private-invalid-json', '[]', '{}']:
            with self.assertRaisesRegex(ValueError, '^Invalid own Opka Firebase Android configuration$'):
                module.validate_configuration(raw)

    def test_writes_private_runner_file_and_only_exports_its_path(self):
        with tempfile.TemporaryDirectory() as temp:
            envfile, output = Path(temp) / 'env', Path(temp) / 'output'
            with patch.dict(os.environ, {'RUNNER_TEMP': temp, 'GITHUB_ENV': str(envfile),
                            'GITHUB_OUTPUT': str(output), 'OPKA_GOOGLE_SERVICES_JSON': fixture()}):
                module.main()
            target = Path(temp) / 'opka-google-services.json'
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(envfile.read_text(), f'OPKA_GOOGLE_SERVICES_FILE={target}\n')
            outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(outputs['configured'], 'true')
            self.assertEqual(outputs['client_sha256'], hashlib.sha256(target.read_bytes()).hexdigest())
            self.assertRegex(outputs['build_env_sha256'], '^[0-9a-f]{64}$')
            self.assertNotIn(fixture(), output.read_text())

    def test_missing_secret_keeps_push_explicitly_unconfigured(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'output'
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output),
                            'OPKA_GOOGLE_SERVICES_JSON': ''}):
                module.main()
            outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(outputs['configured'], 'false')
            self.assertEqual(outputs['client_sha256'], 'unconfigured')
            self.assertRegex(outputs['build_env_sha256'], '^[0-9a-f]{64}$')
            self.assertFalse((Path(temp) / 'opka-google-services.json').exists())

    def prepared_fingerprint(self, raw):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'output'
            with patch.dict(os.environ, {'RUNNER_TEMP': temp, 'GITHUB_ENV': str(Path(temp) / 'env'),
                            'GITHUB_OUTPUT': str(output), 'OPKA_GOOGLE_SERVICES_JSON': raw}, clear=True):
                module.main()
            data = (Path(temp) / 'opka-google-services.json').read_bytes()
            outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(outputs['client_sha256'], hashlib.sha256(data).hexdigest())
            return outputs['client_sha256']

    def test_fingerprints_actual_prepared_bytes_not_runner_path_or_raw_whitespace(self):
        compact = fixture()
        formatted = json.dumps(json.loads(compact), indent=4)
        self.assertEqual(self.prepared_fingerprint(compact), self.prepared_fingerprint(formatted))

    def test_same_project_changed_client_configuration_invalidates_cache(self):
        first = json.loads(fixture())
        first['client'][0]['api_key'] = [{'current_key': 'synthetic-first-client-key'}]
        second = json.loads(json.dumps(first))
        second['client'][0]['api_key'][0]['current_key'] = 'synthetic-second-client-key'
        self.assertNotEqual(self.prepared_fingerprint(json.dumps(first)),
                            self.prepared_fingerprint(json.dumps(second)))

    def test_malformed_input_fails_before_any_cache_output_or_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target, output = Path(temp) / 'opka-google-services.json', Path(temp) / 'output'
            with patch.dict(os.environ, {'RUNNER_TEMP': temp, 'GITHUB_ENV': str(Path(temp) / 'env'),
                            'GITHUB_OUTPUT': str(output), 'OPKA_GOOGLE_SERVICES_JSON': 'private-invalid-json'}):
                with self.assertRaisesRegex(ValueError, '^Invalid own Opka Firebase Android configuration$'):
                    module.main()
            self.assertFalse(target.exists())
            self.assertFalse(output.exists())

    def test_payload_environment_changes_invalidate_cache_without_exporting_values(self):
        baseline = module.build_environment_fingerprint({'OPKA_MOBILE_BUILD': '1'})
        for updates in [
            {'OPKA_MOBILE_BUILD': '0'}, {'ORCA_IOS_APS_ENVIRONMENT': 'production'},
            {'NODE_ENV': 'production'}, {'EXPO_PUBLIC_API_URL': 'https://synthetic.invalid'},
        ]:
            self.assertNotEqual(baseline, module.build_environment_fingerprint(
                {'OPKA_MOBILE_BUILD': '1', **updates}))
        self.assertEqual(baseline, module.build_environment_fingerprint({
            'OPKA_MOBILE_BUILD': '1', 'RUNNER_TEMP': '/different/path',
            'OPKA_GOOGLE_SERVICES_FILE': '/different/client.json',
            'OPKA_ANDROID_KEYSTORE_PASSWORD': 'synthetic-not-a-build-input',
            'GOOGLE_APPLICATION_CREDENTIALS': '/never-read/service-account.json',
        }))


if __name__ == '__main__':
    unittest.main()
