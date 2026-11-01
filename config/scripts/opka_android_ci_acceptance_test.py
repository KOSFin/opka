"""Offline orchestration regressions; no ADB, APK, host or model is launched."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).with_name('opka-android-ci-acceptance.py'))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class IndependentStages(unittest.TestCase):
    def test_reset_verifies_absence_instead_of_trusting_failed_uninstall(self):
        for code, output, error, rejected in [
                (0, 'package:/data/app/old/base.apk', '', True),
                (1, '', 'device offline', True),
                (1, '', '', False)]:
            with self.subTest(code=code, rejected=rejected):
                reply = subprocess.CompletedProcess(['synthetic'], code, output, error)
                with patch.object(acceptance.subprocess, 'run', return_value=reply) as command:
                    if rejected:
                        with self.assertRaisesRegex(RuntimeError, 'clean synthetic application reset'):
                            acceptance.reset_phase('emulator-5554')
                    else:
                        acceptance.reset_phase('emulator-5554')
                    self.assertEqual(command.call_args.args[0], ['adb', '-s', 'emulator-5554', 'shell', 'pm', 'path', 'com.kosfin.opka.mobile'])
                    self.assertEqual(command.call_args.kwargs['timeout'], 10)

    def test_failed_stage_keeps_independent_stages_and_aggregate_fails_without_secret_errors(self):
        calls = []
        def fail():
            calls.append('first')
            raise subprocess.CalledProcessError(1, ['adb', 'secret-pairing-link'], output='private-token')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'stages.json'
            results = acceptance.collect_stages([
                ('os-update', fail), ('native-https', lambda: calls.append('native')),
                ('baseline-idle', lambda: calls.append('idle')), ('real-ui', lambda: calls.append('ui'))
            ], output, lambda: True)
            receipt = json.loads(output.read_text())
            self.assertEqual(calls, ['first', 'native', 'idle', 'ui'])
            self.assertEqual([item['status'] for item in results], ['failed', 'passed', 'passed', 'passed'])
            self.assertFalse(receipt['allPassed'])
            self.assertNotIn('secret-pairing-link', output.read_text())
            self.assertNotIn('private-token', output.read_text())

    def test_device_loss_aborts_remaining_phases_without_waiting_or_claiming_success(self):
        calls = []
        readiness = iter([True, False])
        with tempfile.TemporaryDirectory() as directory:
            results = acceptance.collect_stages([
                ('os-update', lambda: calls.append('first')),
                ('native-https', lambda: calls.append('second')),
                ('real-ui', lambda: calls.append('third'))
            ], Path(directory) / 'stages.json', lambda: next(readiness))
        self.assertEqual(calls, ['first'])
        self.assertEqual([item['status'] for item in results], ['passed', 'failed', 'skipped'])
        self.assertEqual(results[-1]['reason'], 'device-unavailable')

    def test_ui_prerequisite_skip_is_not_passed_and_has_only_allowlisted_reason(self):
        def skip():
            raise acceptance.StageSkipped('ui-install-failed')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'stages.json'
            results = acceptance.collect_stages([('real-ui', skip)], output, lambda: True)
            self.assertFalse(json.loads(output.read_text())['allPassed'])
            self.assertEqual(results[0]['reason'], 'ui-install-failed')
            self.assertEqual(acceptance.StageSkipped('secret-token').reason, 'stage-prerequisite-failed')

    def test_timeout_terminates_group_including_child_driver_before_next_phase(self):
        process = Mock(pid=42)
        process.wait.side_effect = [subprocess.TimeoutExpired(['private-argv'], 1), 0, 0]
        with patch.object(acceptance.subprocess, 'Popen', return_value=process), patch.object(acceptance.os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                acceptance.run('Synthetic timed stage', ['synthetic'], timeout=1)
        self.assertEqual(kill.call_args_list[0].args, (42, signal.SIGTERM))
        self.assertEqual(kill.call_args_list[1].args, (42, signal.SIGKILL))

    def test_runtime_receipt_keeps_provider_identity_without_raw_dumpsys_output(self):
        text = 'Current WebView package (name, version): (com.google.android.webview, 131.0.6778.39)\nprivate-unrelated-value'
        with tempfile.TemporaryDirectory() as directory, patch.object(acceptance.subprocess, 'check_output', return_value=text):
            target = Path(directory) / 'runtime.json'
            acceptance.record_webview_environment('emulator-5554', target)
            self.assertEqual(json.loads(target.read_text()), {'providerPackage': 'com.google.android.webview', 'providerVersion': '131.0.6778.39'})
            self.assertNotIn('private-unrelated-value', target.read_text())

    def test_release_uses_exact_installer_for_three_stages_without_current_source_fixtures(self):
        calls = []
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                environment = {'GITHUB_ACTIONS': 'true', 'ANDROID_HOME': '/synthetic',
                    'CANDIDATE_VERSION': '1.4.236-rc.9', 'RELEASE_SIGNER': 'true',
                    'CANDIDATE_ARTIFACT_DIR': 'qualified-installer', 'GITHUB_SHA': 'b' * 40,
                    'OPKA_ANDROID_CERTIFICATE_SHA256': 'a' * 64}
                with patch.dict(os.environ, environment), patch.object(acceptance.subprocess, 'check_output', return_value='emulator-5554'), patch.object(acceptance, 'device_available', return_value=True), patch.object(acceptance, 'reset_phase'), patch.object(acceptance, 'clear_proxy'), patch.object(acceptance, 'verify_candidate', return_value={'apkSha256': 'd' * 64, 'candidateRebuilt': False}) as verify, patch.object(acceptance, 'run', side_effect=lambda label, args, **kwargs: calls.append((label, args))), patch.object(acceptance, 'run_ui', side_effect=lambda serial, apk, evidence: calls.append(('UI', apk))):
                    self.assertEqual(acceptance.main(), 0)
                verify.assert_called_once_with(Path('qualified-installer'), '1.4.236-rc.9', 'b' * 40, 'a' * 64)
                proof = json.loads(Path('out/android-native-ui/candidate-artifact.json').read_text())
                self.assertTrue(proof['allPassed'])
                self.assertEqual([stage['stage'] for stage in proof['stages']], ['baseline-idle', 'real-ui', 'native-https'])
                self.assertIn(('UI', 'qualified-installer/opka-android.apk'), calls)
                native = calls[-1][1]
                self.assertIn('--legacy-only', native)
                self.assertIn('qualified-installer/opka-android.apk', native)
                self.assertNotIn('out/android-update-fixtures/rc5.apk', native)
                self.assertNotIn('OS confirmation and retained state', [label for label, _ in calls])
            finally:
                os.chdir(previous)

    def test_composition_resets_and_clears_proxy_for_every_phase_and_returns_failure(self):
        calls = []
        def stage(label, *args, **kwargs):
            calls.append(label)
            if label == 'OS confirmation and retained state':
                raise RuntimeError('private-link-must-not-be-serialized')
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'ANDROID_HOME': '/synthetic', 'CANDIDATE_VERSION': '1.4.236-rc.8', 'RELEASE_SIGNER': 'false'}), \
                     patch.object(acceptance.subprocess, 'check_output', return_value='emulator-5554'), \
                     patch.object(acceptance, 'device_available', return_value=True), \
                     patch.object(acceptance, 'reset_phase', side_effect=lambda serial: calls.append('reset')), \
                     patch.object(acceptance, 'clear_proxy', side_effect=lambda serial: calls.append('proxy-clear')), \
                     patch.object(acceptance, 'run', side_effect=stage), \
                     patch.object(acceptance, 'run_ui', side_effect=lambda *args: calls.append('ui')):
                    self.assertEqual(acceptance.main(), 1)
                self.assertEqual(calls.count('reset'), 4)
                self.assertEqual(calls.count('proxy-clear'), 4)
                self.assertIn('ui', calls)
                pipeline = json.loads(Path('out/android-native-ui/pipeline.json').read_text())
                self.assertFalse(pipeline['allPassed'])
                self.assertTrue(pipeline['realSyntheticHost'])
            finally:
                os.chdir(previous)

    def test_uninstalled_ui_dependency_does_not_claim_real_host_or_clean_apk_success(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'ANDROID_HOME': '/synthetic', 'RELEASE_SIGNER': 'false'}), \
                     patch.object(acceptance.subprocess, 'check_output', return_value='emulator-5554'), \
                     patch.object(acceptance, 'device_available', return_value=True), \
                     patch.object(acceptance, 'reset_phase'), patch.object(acceptance, 'clear_proxy'), \
                     patch.object(acceptance, 'run'), \
                     patch.object(acceptance, 'run_ui', side_effect=acceptance.StageSkipped('ui-install-failed')):
                    self.assertEqual(acceptance.main(), 1)
                pipeline = json.loads(Path('out/android-native-ui/pipeline.json').read_text())
                self.assertFalse(pipeline['realSyntheticHost'])
                self.assertFalse(pipeline['realApk'])
                self.assertFalse(pipeline['allPassed'])
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
