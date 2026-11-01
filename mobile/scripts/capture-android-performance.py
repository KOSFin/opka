#!/usr/bin/env python3
"""Capture bounded app-only Android diagnostics; workload/navigation is driven separately."""
import argparse
import importlib.util
import selectors
import json
import re
import subprocess
import time
from pathlib import Path


_spec = importlib.util.spec_from_file_location('batterystats', Path(__file__).with_name('android-batterystats.py'))
_stats = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_stats)


def run(adb, args, limit=512_000):
    started = time.monotonic()
    process = None
    try:
        process = subprocess.Popen([*adb, 'shell', *args], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        data = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while time.monotonic() - started < 12 and len(data) <= limit:
                if not selector.select(timeout=0.25):
                    continue
                block = process.stdout.read1(min(16384, limit + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
        truncated = len(data) > limit
        if process.poll() is None:
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                process.kill()
        code = process.wait(timeout=2)
        return {'ok': code == 0 and not truncated, 'text': bytes(data[:limit]).decode(errors='replace'),
                'truncated': truncated, 'elapsedMs': round((time.monotonic() - started) * 1000)}
    except (subprocess.TimeoutExpired, OSError) as error:
        return {'ok': False, 'unavailable': type(error).__name__}
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=2)


def battery_snapshot(adb, package, uid):
    human = run(adb, ['dumpsys', 'batterystats', '--charged', package])
    machine = run(adb, ['dumpsys', 'batterystats', '--charged', '--checkin', package])
    return {'network': _stats.parse_network(machine.get('text', ''), uid) if machine.get('ok') else
            {'available': False, 'reason': 'batterystats-command-unavailable'},
            'powerEstimate': _stats.parse_power_estimate(human.get('text', ''), uid) if human.get('ok') else
            {'available': False, 'reason': 'batterystats-command-unavailable'}}


def snapshot(adb, package, elapsed):
    memory = run(adb, ['dumpsys', 'meminfo', package])
    total = re.search(r'TOTAL PSS:\s*(\d+)', memory.get('text', ''))
    memory['totalPssKb'] = int(total.group(1)) if total else None
    cpu = run(adb, ['dumpsys', 'cpuinfo'])
    # Keep only this app's CPU rows; do not archive other apps' process inventory.
    if cpu.get('ok'):
        cpu['text'] = '\n'.join(line for line in cpu['text'].splitlines() if package in line)
        cpu['sampleAvailable'] = bool(cpu['text'])
    return {'elapsedSeconds': round(elapsed, 3), 'memory': memory, 'cpu': cpu}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--serial', required=True)
    parser.add_argument('--package', default='com.kosfin.opka.mobile')
    parser.add_argument('--label', required=True)
    parser.add_argument('--scenario', choices=['idle-foreground', 'idle-background', 'navigation', 'synthetic-stream'], required=True)
    parser.add_argument('--duration-seconds', type=int, default=60)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not 5 <= args.duration_seconds <= 300 or not re.fullmatch(r'[a-zA-Z0-9_.]+', args.package):
        parser.error('Use a package identifier and a duration from5 to300 seconds')
    adb = [args.adb, '-s', args.serial]
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    package_info = run(adb, ['dumpsys', 'package', args.package])
    version = '\n'.join(line.strip() for line in package_info.get('text', '').splitlines()
                        if re.match(r'\s*version(?:Name|Code)=', line))
    uid = _stats.parse_uid(package_info.get('text', ''))
    battery_before = battery_snapshot(adb, args.package, uid)
    report = {'schema': 2, 'label': args.label, 'scenario': args.scenario,
              'package': args.package, 'installedVersion': version, 'durationSeconds': args.duration_seconds,
              'physicalBatteryMeasured': False, 'networkBytesMeasured': False, 'batteryBefore': battery_before,
              'limitations': ['Navigation must be replayed by a separate synthetic test driver.',
                              'dumpsys CPU rows are diagnostic windows, not a calibrated energy estimate.',
                              'No network or battery zero is inferred from an unavailable metric.'], 'samples': []}
    run(adb, ['dumpsys', 'gfxinfo', args.package, 'reset'])
    started = time.monotonic()
    while True:
        elapsed = time.monotonic() - started
        report['samples'].append(snapshot(adb, args.package, elapsed))
        remaining = args.duration_seconds - (time.monotonic() - started)
        if remaining <= 0:
            break
        time.sleep(min(10, remaining))
    report['batteryAfter'] = battery_snapshot(adb, args.package, uid)
    report['networkDelta'] = _stats.network_delta(battery_before['network'], report['batteryAfter']['network'])
    report['networkBytesMeasured'] = report['networkDelta']['available']
    report['frames'] = run(adb, ['dumpsys', 'gfxinfo', args.package, 'framestats'])
    pss = [s['memory']['totalPssKb'] for s in report['samples'] if s['memory'].get('totalPssKb') is not None]
    report['pssSummaryKb'] = {'first': pss[0], 'last': pss[-1], 'max': max(pss)} if pss else None
    (output / 'performance.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({'label': args.label, 'samples': len(report['samples']),
                      'output': str(output / 'performance.json'), 'physicalBatteryMeasured': False}))


if __name__ == '__main__':
    main()
