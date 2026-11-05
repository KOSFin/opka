import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('residency', Path(__file__).with_name('compare-android-residency.py'))
residency = importlib.util.module_from_spec(spec)
spec.loader.exec_module(residency)


class AndroidResidencyTest(unittest.TestCase):
    def test_rejects_wrong_image_even_with_correct_api(self):
        valid = 'Pkg.Revision=17\nAndroidVersion.ApiLevel=33\nSystemImage.TagId=google_apis\nSystemImage.Abi=x86_64'
        self.assertEqual(residency.verify_image(valid)['Pkg.Revision'], '17')
        for changed in (valid.replace('=17', '=18'), valid.replace('x86_64', 'arm64-v8a'),
                        valid.replace('google_apis', 'default'), valid.replace('=33', '=30')):
            with self.assertRaises(ValueError):
                residency.verify_image(changed)

    def test_refuses_another_apk_before_install(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'wrong.apk'
            path.write_bytes(b'not-the-production-apk')
            with self.assertRaises(ValueError):
                residency.verify_apk(path, 'rc7')

    def test_smaps_aggregates_residency_without_retaining_paths(self):
        text = '''1000-2000 r--p 00000000 00:00 1 /data/app/private-id/base.apk
Rss: 20 kB
Pss: 10 kB
SwapPss: 0 kB
2000-3000 r--p 00000000 00:00 2 /private/account/classes.dex
Rss: 8 kB
Pss: 4 kB
3000-4000 rw-p 00000000 00:00 0 [anon:libc_malloc]
Pss: 12 kB
SwapPss: 7 kB
4000-5000 r--p 00000000 00:00 3 /data/app/another/base.apk
Pss: 5 kB
'''
        result = residency.summarize_mappings(text)
        self.assertTrue(result['available'])
        self.assertEqual(result['groupsKb']['apk']['Pss'], 15)
        self.assertEqual(result['groupsKb']['other']['SwapPss'], 7)
        self.assertNotIn('private', str(result))
        self.assertNotIn('account', str(result))

    def test_denied_smaps_is_unavailable_not_zero(self):
        for value in ('', 'cat: /proc/123/smaps: Permission denied'):
            self.assertFalse(residency.summarize_mappings(value)['available'])

    def test_pressure_records_only_selected_global_totals(self):
        result = residency.parse_pressure('MemTotal: 2000 kB\nMemAvailable: 900 kB\nSwapFree: 0 kB\nPrivate: 99 kB\n')
        self.assertEqual(result, {'MemTotal': 2000, 'MemAvailable': 900, 'SwapFree': 0})
        self.assertNotIn('Private', result)

    def test_process_selection_rejects_restart_or_multiple_processes(self):
        self.assertEqual(residency.require_pid('123\n'), '123')
        for text in ('', '0', '123 456', '123\n456'):
            with self.assertRaises(ValueError):
                residency.require_pid(text)

    def test_activity_capture_cannot_substitute_other_app(self):
        self.assertEqual(residency.own_activity('mResumedActivity: ActivityRecord{42 u0 com.kosfin.opka.mobile/.MainActivity t3}'), '.MainActivity')
        self.assertIsNone(residency.own_activity('mResumedActivity: ActivityRecord{42 u0 other.app/.MainActivity t3}'))

    def test_order_balances_which_release_runs_first(self):
        self.assertEqual(residency.ORDER, ('rc7', 'rc8', 'rc8', 'rc7'))

    def test_offline_requires_actual_radio_and_default_network_evidence(self):
        self.assertEqual(residency.offline_condition('1', '0', '0',
                         'Active default network: none')['activeDefaultNetwork'], 'none')
        for airplane, wifi, mobile, connectivity in [
                ('0', '0', '0', 'Active default network: none'),
                ('1', '1', '0', 'Active default network: none'),
                ('1', '0', '1', 'Active default network: none'),
                ('1', '0', '0', 'Active default network: 101'),
                ('1', '0', '0', '')]:
            with self.assertRaises(ValueError):
                residency.offline_condition(airplane, wifi, mobile, connectivity)

    def test_bad_digest_never_mutates_emulator(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            image = root / 'source.properties'
            image.write_text('Pkg.Revision=17\nAndroidVersion.ApiLevel=33\nSystemImage.TagId=google_apis\nSystemImage.Abi=x86_64')
            argv = ['compare', '--serial', 'emulator-5554', '--rc7-apk', str(root / 'a.apk'),
                    '--rc8-apk', str(root / 'b.apk'), '--system-image-properties', str(image),
                    '--output', str(root / 'out'), '--try-adb-root']

            def read(_adb, command, **_kwargs):
                return {'ok': True, 'text': {'ro.kernel.qemu': '1',
                        'ro.build.version.sdk': '33', 'ro.product.cpu.abi': 'x86_64'}[command[1]]}

            with patch('sys.argv', argv), patch.dict('os.environ', {'GITHUB_ACTIONS': 'true'}), \
                    patch.object(residency.collector, 'run', side_effect=read), \
                    patch.object(residency, 'verify_apk', side_effect=ValueError('bad digest')), \
                    patch.object(residency.subprocess, 'run') as mutate:
                with self.assertRaises(ValueError):
                    residency.main()
                mutate.assert_not_called()
            self.assertIn('"complete": false', (root / 'out' / 'residency-comparison.json').read_text())

    def test_optional_root_records_actual_uid_not_adb_exit_status(self):
        replies = [subprocess.CompletedProcess([], 0, b'2000\n'),
                   subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0),
                   subprocess.CompletedProcess([], 0, b'2000\n')]
        with patch.object(residency.subprocess, 'run', side_effect=replies) as run:
            result = residency.inspect_adb_access(['adb', '-s', 'emulator-5554'], True)
        self.assertFalse(result['rootConfirmed'])
        self.assertTrue(result['rootCommandCompleted'])
        self.assertEqual(result['uidAfter'], 2000)
        self.assertEqual(run.call_args_list[1].args[0][-1], 'root')
        self.assertEqual(run.call_args_list[2].args[0][-1], 'wait-for-device')
        self.assertTrue(all(call.kwargs['timeout'] <= 10 for call in run.call_args_list))

    def test_root_timeout_is_nonfatal_and_uid_is_still_verified(self):
        with patch.object(residency, 'adb_uid', side_effect=[2000, 2000]), \
                patch.object(residency.subprocess, 'run', side_effect=subprocess.TimeoutExpired('adb', 10)):
            result = residency.inspect_adb_access(['adb'], True)
        self.assertFalse(result['rootConfirmed'])
        self.assertEqual(result['unavailableReason'], 'TimeoutExpired')

    def test_root_opt_out_never_restarts_adbd(self):
        with patch.object(residency, 'adb_uid', side_effect=[2000, 2000]), \
                patch.object(residency.subprocess, 'run') as run:
            self.assertFalse(residency.inspect_adb_access(['adb'], False)['rootConfirmed'])
            run.assert_not_called()

    def test_root_success_requires_uid_zero(self):
        with patch.object(residency, 'adb_uid', side_effect=[2000, 0]), \
                patch.object(residency.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            self.assertTrue(residency.inspect_adb_access(['adb'], True)['rootConfirmed'])


if __name__ == '__main__':
    unittest.main()
