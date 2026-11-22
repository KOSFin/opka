"""Fetch public primary-source receipts without SDKs or credentials."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

SOURCES = {
    'github-cache': 'https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching',
    'github-required': 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks',
    'github-workflow': 'https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax',
    'gradle-build': 'https://docs.gradle.org/current/userguide/build_cache.html',
    'gradle-configuration': 'https://docs.gradle.org/current/userguide/configuration_cache.html',
    'nx-affected': 'https://nx.dev/ci/features/affected',
    'nx-inputs': 'https://nx.dev/docs/guides/tasks--caching/configure-inputs',
    'turbo-caching': 'https://turborepo.com/docs/crafting-your-repository/caching',
    'turbo-environment': 'https://turborepo.com/docs/crafting-your-repository/using-environment-variables',
    'vitest-cli': 'https://vitest.dev/guide/cli.html',
    'vitest-performance': 'https://vitest.dev/guide/improving-performance.html',
}

def main():
    child = subprocess.Popen(['sleep', '1'])
    cgroups = {
        'python': Path('/proc/self/cgroup').read_text().strip(),
        'child': Path(f'/proc/{child.pid}/cgroup').read_text().strip(),
    }
    child.wait()
    receipt = {
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'cgroups': cgroups,
        'sources': [],
    }
    for name, url in SOURCES.items():
        entry = {'name': name, 'requested_url': url}
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'opka-ci-pilot-source-review'})
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read(3_000_000)
                entry.update(status=response.status, final_url=response.url,
                             bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
        except Exception as error:
            entry['error'] = str(error)
        receipt['sources'].append(entry)
    target = Path(__file__).with_name('official-source-receipts.json')
    target.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'path': str(target), 'sources': len(receipt['sources']),
                      'errors': [s['name'] for s in receipt['sources'] if 'error' in s],
                      'cgroups': cgroups}))

if __name__ == '__main__':
    main()
