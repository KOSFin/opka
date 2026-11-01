import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('stats', Path(__file__).with_name('android-batterystats.py'))
stats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stats)


class OwnUidNetworkTest(unittest.TestCase):
    def test_filters_other_apps_and_global_rows(self):
        text = '\n'.join(['9,0,l,gn,999,999,999,999,999,999,999,999',
                          '9,10099,l,nt,777,777,777,777,777,777,777,777',
                          '9,10123,l,nt,1,2,3,4,5,6,7,8,90,10'])
        result = stats.parse_network(text, 10123)
        self.assertEqual(result['counters']['wifiRxBytes'], 3)
        self.assertNotIn('777', str(result))
        self.assertNotIn('999', str(result))

    def test_unsupported_missing_and_ambiguous_are_not_zero(self):
        for text in ['', '10,10123,l,nt,1,2,3,4,5,6,7,8',
                     '9,10123,l,nt,?,2,3,4,5,6,7,8',
                     '\n'.join(['9,10123,l,nt,1,2,3,4,5,6,7,8'] * 2)]:
            self.assertFalse(stats.parse_network(text, 10123)['available'])

    def test_delta_detects_reset_and_unavailable(self):
        before = stats.parse_network('9,10123,l,nt,1,2,3,4,5,6,7,8', 10123)
        after = stats.parse_network('9,10123,l,nt,2,3,4,5,6,7,8,9', 10123)
        self.assertEqual(stats.network_delta(before, after)['counters']['wifiTxBytes'], 1)
        self.assertFalse(stats.network_delta(after, before)['available'])
        self.assertFalse(stats.network_delta({}, after)['available'])

    def test_resolves_only_own_package_user_id(self):
        self.assertEqual(stats.parse_uid('  userId=10123\n'), 10123)
        self.assertIsNone(stats.parse_uid('nothing'))

    def test_estimate_excludes_other_uid_and_is_not_physical_battery(self):
        result = stats.parse_power_estimate(' UID u0a999: 888\n UID u0a123: 0.2\n', 10123)
        self.assertEqual(result['estimatedMahSinceCharge'], 0.2)
        self.assertFalse(result['physicalBatteryMeasured'])
        self.assertFalse(stats.parse_power_estimate('UID u0a999: 888', 10123)['available'])


if __name__ == '__main__':
    unittest.main()
