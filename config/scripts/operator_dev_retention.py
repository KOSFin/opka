"""Explicit-manifest retention for reproducible development subtrees, dry-run by default."""
import argparse
import fcntl
import json
import os
import re
import shutil
import stat
import time
from collections import Counter
from pathlib import Path
from operator_dev_retention_processes import process_references, references_root

OUTPUTS = {'out', 'dist', 'node_modules', '.build'}
GLOBAL_SNAPSHOT_ENTRIES = 100000
PROTECTED = {'.git', '.orca', '.codex', '.agents', 'fork-docs', 'reports', '.gradle',
             'sdk', 'sdks', 'android-sdk', 'auth', 'history', 'sessions', 'rollouts',
             'auth.json', 'credentials.json', 'codex-routing-replay'}
PROJECT_SOURCE = {'src', 'docs'}


def private_owned(info, uid):
    return info.st_uid == uid and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022)


def canonical(path):
    value = Path(path)
    if not value.is_absolute() or '..' in value.parts or value.resolve(strict=True) != value:
        raise ValueError('noncanonical-or-linked-root')
    return value


def related(first, second):
    return first == second or first in second.parents or second in first.parents


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns,
            info.st_size, info.st_mode, info.st_uid)


def validate(policy):
    if policy.get('schema') != 1 or not isinstance(policy.get('ownerUid'), int):
        raise ValueError('invalid-policy-schema')
    for key, minimum, maximum in [('minAgeDays', 1, 3650), ('keepNewest', 0, 8),
                                  ('maxDeletes', 1, 16), ('maxBytes', 1, 64 * 1024**3),
                                  ('reserveBytes', 1, 1024**5)]:
        if not isinstance(policy.get(key), int) or not minimum <= policy[key] <= maximum:
            raise ValueError('invalid-policy-limit')
    if not 1 <= len(policy.get('roots', [])) <= 64 or not policy.get('protectedPaths'):
        raise ValueError('missing-reviewed-roots-or-protections')
    protected = [canonical(path) for path in policy['protectedPaths']]
    roots = []
    for entry in policy['roots']:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', entry.get('id', '')):
            raise ValueError('invalid-root-id')
        path = canonical(entry['path'])
        info = path.lstat()
        if (len(path.parts) < 4 or not stat.S_ISDIR(info.st_mode)
                or any(part.lower() in PROTECTED | PROJECT_SOURCE for part in path.parts)
                or not private_owned(info, policy['ownerUid'])
                or info.st_dev != entry.get('device') or info.st_ino != entry.get('inode')):
            raise ValueError('reviewed-root-identity-unverifiable')
        outputs = entry.get('outputs', [])
        if not outputs or not set(outputs) <= OUTPUTS or len(outputs) != len(set(outputs)):
            raise ValueError('unknown-output-kind')
        if any(related(path, other[1]) for other in roots):
            raise ValueError('overlapping-reviewed-roots')
        roots.append((entry['id'], path, outputs, info))
    return roots, protected


def inspect_tree(path, uid, device, budget, dependency=False):
    if budget[0] <= 0:
        raise RuntimeError('global-tree-entry-budget')
    pending, snapshot, blocks, newest = [path], [], 0, 0
    charged = set()
    while pending:
        current = pending.pop()
        info = current.lstat()
        if budget[0] <= 0:
            raise RuntimeError('global-tree-entry-budget')
        budget[0] -= 1
        if info.st_dev != device or not private_owned(info, uid):
            raise RuntimeError('tree-ownership-or-mount-unverifiable')
        vendored = dependency or 'node_modules' in current.relative_to(path).parts
        denied = {'.git', '.orca', '.codex', '.agents', 'fork-docs', '.gradle',
                  'auth.json', 'credentials.json', 'codex-routing-replay'} if vendored else PROTECTED | PROJECT_SOURCE
        if current != path and current.name.lower() in denied:
            raise RuntimeError('protected-content')
        snapshot.append((current, identity(info)))
        newest = max(newest, info.st_mtime)
        if stat.S_ISDIR(info.st_mode):
            for child in current.iterdir():
                if len(pending) >= budget[0]:
                    raise RuntimeError('global-tree-entry-budget')
                pending.append(child)
        elif not stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
            raise RuntimeError('unknown-file-type')
        if (info.st_dev, info.st_ino) not in charged:
            charged.add((info.st_dev, info.st_ino))
            blocks += info.st_blocks * 512
    return snapshot, blocks, newest


def unchanged(snapshot):
    return all(identity(path.lstat()) == expected for path, expected in snapshot)


def same_root(path, expected):
    current = path.lstat()
    return (current.st_dev, current.st_ino, current.st_uid, current.st_mode) == (
        expected.st_dev, expected.st_ino, expected.st_uid, expected.st_mode)


def free_bytes(path):
    info = os.statvfs(path)
    return info.f_bavail * info.f_frsize


def retain(policy, apply=False, census=process_references, now=None):
    roots, protected = validate(policy)
    now = time.time() if now is None else now
    skipped, candidates, removed = Counter(), [], []
    snapshot_budget = [GLOBAL_SNAPSHOT_ENTRIES]
    try:
        rows = census()
    except (OSError, RuntimeError):
        return {'mode': 'apply' if apply else 'dry-run', 'removed': [],
                'skipped': {'process-census-unverifiable': 1}}
    before = {label: free_bytes(root) for label, root, _, _ in roots}
    for label, root, outputs, root_info in roots:
        if references_root(root, rows):
            skipped['active-root'] += len(outputs)
            continue
        for output in outputs:
            path = root / output
            try:
                info = path.lstat()
                if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
                    skipped['linked-or-unknown-output'] += 1
                    continue
                if any(related(path, item) for item in protected):
                    skipped['protected-path'] += 1
                    continue
                snapshot, allocated, newest = inspect_tree(path, policy['ownerUid'], root_info.st_dev, snapshot_budget,
                                                          dependency=output == 'node_modules')
                candidates.append({'root': root, 'root_info': root_info, 'path': path,
                                   'id': label, 'output': output, 'snapshot': snapshot,
                                   'allocated': allocated, 'newest': newest})
            except FileNotFoundError:
                skipped['absent'] += 1
            except (OSError, RuntimeError):
                skipped['unverifiable-or-protected-tree'] += 1
    del rows
    keep = set()
    for output in OUTPUTS:
        matching = sorted((item for item in candidates if item['output'] == output),
                          key=lambda item: item['newest'], reverse=True)
        keep.update(item['path'] for item in matching[:policy['keepNewest']])
    selected, charged = [], 0
    for item in sorted(candidates, key=lambda value: value['newest']):
        if item['path'] in keep or now - item['newest'] < policy['minAgeDays'] * 86400:
            skipped['retained-by-age-or-count'] += 1
            continue
        if len(selected) >= policy['maxDeletes'] or charged + item['allocated'] > policy['maxBytes']:
            skipped['deletion-budget'] += 1
            continue
        selected.append(item)
        charged += item['allocated']
    for item in selected:
        if apply:
            try:
                if (references_root(item['root'], census())
                        or not same_root(item['root'], item['root_info'])
                        or not unchanged(item['snapshot'])):
                    skipped['active-or-changed-before-delete'] += 1
                    continue
                if not shutil.rmtree.avoids_symlink_attacks:
                    raise RuntimeError('safe-directory-removal-unavailable')
                shutil.rmtree(item['path'])
            except (OSError, RuntimeError):
                skipped['deletion-unverifiable'] += 1
                continue
        removed.append({'rootId': item['id'], 'output': item['output'],
                        'allocatedBytes': item['allocated']})
    after = {label: free_bytes(root) for label, root, _, _ in roots}
    return {'mode': 'apply' if apply else 'dry-run', 'removed' if apply else 'wouldRemove': removed,
            'skipped': dict(skipped), 'freeBeforeBytes': before, 'freeAfterBytes': after,
            'reserveBytes': policy['reserveBytes'], 'snapshotEntries': GLOBAL_SNAPSHOT_ENTRIES - snapshot_budget[0],
            'reserveSatisfied': all(value >= policy['reserveBytes'] for value in after.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        if args.apply and os.geteuid() != 0:
            raise RuntimeError('apply-needs-privileged-process-census')
        manifest = canonical(args.manifest)
        with manifest.open('rb') as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > 65536
                    or info.st_uid != os.geteuid() or info.st_mode & 0o077):
                raise RuntimeError('private-owned-manifest-required')
            fcntl.flock(source.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            policy = json.load(source)
            if any(related(manifest, canonical(entry['path']) / output)
                   for entry in policy.get('roots', []) for output in entry.get('outputs', [])):
                raise RuntimeError('manifest-inside-deletion-scope')
            result = retain(policy, apply=args.apply)
            print(json.dumps(result, sort_keys=True))
            if args.apply and not result.get('reserveSatisfied', False):
                raise SystemExit(3)
    except (OSError, RuntimeError, ValueError, KeyError, TypeError):
        print(json.dumps({'error': 'retention-refused-no-private-details'}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
