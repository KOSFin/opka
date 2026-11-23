"""Measure compiler reuse without skipping source checks, tests or reproducibility builds."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
    phase = sys.argv[1]
    assert phase in ('cold', 'warm', 'clear')
    output = Path('out/replay-go-probe')
    output.mkdir(parents=True, exist_ok=True)
    cache = Path(os.environ['RUNNER_TEMP']) / 'opka-replay-go-cache'
    cache.mkdir(mode=0o700, exist_ok=True)
    cache.chmod(0o700)
    receipt_path = output / 'receipt.json'
    if phase == 'clear':
        assert receipt_path.is_file() and (cache / 'build').is_dir()
        shutil.rmtree(cache / 'build')
        return
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
    else:
        assert phase == 'cold'
        receipt = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                   'event': os.environ['GITHUB_EVENT_NAME'], 'phases': [], 'qualification': False,
                   'runner': {key: os.environ.get(key) for key in
                              ('RUNNER_NAME', 'RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion')}}
    labels = [('baseline-cold', False), ('candidate-cold', True)] if phase == 'cold' else [
        ('candidate-warm', True), ('baseline-warm', False)]
    target = Path('.build/codex-routing-replay/linux-x64')
    for label, cached in labels:
        print(f'Starting {label}', flush=True)
        if target.exists():
            assert receipt['phases'], 'Refuse to remove an unrelated existing replay output'
            shutil.rmtree(target)
        environment = dict(os.environ)
        environment.pop('ORCA_REPLAY_BUILD_CACHE', None)
        if cached:
            environment['ORCA_REPLAY_BUILD_CACHE'] = str(cache)
        started = time.monotonic()
        log_path = output / f'{label}.log'
        with log_path.open('w') as log:
            result = subprocess.run(['bash', 'config/scripts/codex-replay-ci-build.sh', 'linux-x64'],
                                    env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        row = {'name': label, 'seconds': round(time.monotonic() - started, 3),
               'exitCode': result.returncode, 'compilerCache': cached}
        receipt['phases'].append(row)
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
        assert result.returncode == 0, f'{label} failed; retained diagnostics are required'
        row['hashes'] = {name: hashlib.sha256((target / name).read_bytes()).hexdigest()
                         for name in ('cli-proxy-api', 'engine.zip', 'manifest.json')}
        expected = {'cli-proxy-api': 'c1d99badcaeaa40dc7f7b304053ffd4586289710fc81b31743d171b2fcb2a077',
                    'engine.zip': 'd99c92e20ca5b4f529eb8493391ea1b6caad9feaeba8a34718ed8410d68e843c',
                    'manifest.json': 'a6940772785e11e6b59b185a441f737510206811833e99e04be0b8c49425d16c'}
        assert row['hashes'] == expected, 'Existing pinned regression outputs must stay identical'
        row['tests'] = re.findall(r'^=== RUN\s+(\S+)', log_path.read_text(), re.MULTILINE)
        assert row['tests'] and '--- SKIP:' not in log_path.read_text(), 'Fresh Go tests required'
        assert all(old['tests'] == row['tests'] for old in receipt['phases'][:-1])
        row['compilerCacheBytes'] = sum(path.stat().st_size for path in (cache / 'build').rglob('*')
                                        if path.is_file())
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
