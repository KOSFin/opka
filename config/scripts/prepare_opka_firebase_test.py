"""Offline fixtures only; never load the operator's Firebase input."""
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
            self.assertEqual(output.read_text(), 'configured=true\n')

    def test_missing_secret_keeps_push_explicitly_unconfigured(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'output'
            with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output),
                            'OPKA_GOOGLE_SERVICES_JSON': ''}):
                module.main()
            self.assertEqual(output.read_text(), 'configured=false\n')
            self.assertFalse((Path(temp) / 'opka-google-services.json').exists())


if __name__ == '__main__':
    unittest.main()
