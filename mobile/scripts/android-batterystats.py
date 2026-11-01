"""Parse only the requested app UID; discard device history and other applications."""
import csv
import re

NETWORK_FIELDS = ['mobileRxBytes', 'mobileTxBytes', 'wifiRxBytes', 'wifiTxBytes',
                  'mobileRxPackets', 'mobileTxPackets', 'wifiRxPackets', 'wifiTxPackets']


def parse_uid(package_text):
    match = re.search(r'^\s*userId=(\d+)\b', package_text, re.MULTILINE)
    return int(match.group(1)) if match else None


def parse_network(text, uid):
    matches = []
    for row in csv.reader(text.splitlines()):
        if len(row) >= 12 and row[:4] == ['9', str(uid), 'l', 'nt']:
            values = row[4:12]
            if all(re.fullmatch(r'\d+', value) for value in values):
                matches.append(dict(zip(NETWORK_FIELDS, map(int, values))))
    if len(matches) != 1:
        return {'available': False, 'reason': 'own-uid-network-row-unavailable-or-unsupported'}
    return {'available': True, 'counters': matches[0], 'scope': 'own-uid-since-last-charge'}


def network_delta(before, after):
    if not before.get('available') or not after.get('available'):
        return {'available': False, 'reason': 'endpoint-counter-unavailable'}
    differences = {key: after['counters'][key] - before['counters'][key] for key in NETWORK_FIELDS}
    if any(value < 0 for value in differences.values()):
        return {'available': False, 'reason': 'counter-reset-during-observation'}
    return {'available': True, 'counters': differences,
            'scope': 'own-uid-observed-window',
            'isolatedRendererAttribution': 'depends-on-OS-UID-accounting'}


def parse_power_estimate(text, uid):
    if uid is None or uid < 10000:
        return {'available': False, 'reason': 'own-app-uid-unavailable'}
    user, app = divmod(uid, 100000)
    name = f'u{user}a{app - 10000}'
    values = re.findall(r'^\s*UID ' + re.escape(name) + r':\s*(\d+(?:\.\d+)?)\b',
                        text, re.MULTILINE)
    if len(values) != 1:
        return {'available': False, 'reason': 'own-uid-estimated-power-unavailable'}
    return {'available': True, 'estimatedMahSinceCharge': float(values[0]),
            'physicalBatteryMeasured': False}
