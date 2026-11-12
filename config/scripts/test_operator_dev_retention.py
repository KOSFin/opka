import copy
import os
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from operator_dev_retention import retain, validate
from operator_dev_retention_processes import process_references, references_root


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'reviewed'
        self.protected = self.base / 'protected'
        self.root.mkdir(mode=0o700)
        self.protected.mkdir(mode=0o700)
        info = self.root.stat()
        self.policy = {
            'schema': 1, 'ownerUid': os.getuid(), 'minAgeDays': 1, 'keepNewest': 0,
            'maxDeletes': 4, 'maxBytes': 128 * 1024**2, 'reserveBytes': 1,
            'protectedPaths': [str(self.protected)],
            'roots': [{'id': 'fixture', 'path': str(self.root), 'device': info.st_dev,
                       'inode': info.st_ino, 'outputs': ['out', 'dist']}]}

    def output(self, name='out'):
        output = self.root / name
        output.mkdir(mode=0o700)
        (output / 'reproducible.bin').write_bytes(b'x' * 8192)
        old = time.time() - 14 * 86400
        os.utime(output / 'reproducible.bin', (old, old))
        os.utime(output, (old, old))
        return output

    def test_default_preview_and_apply_preserve_source_reports_and_unknown_siblings(self):
        output = self.output()
        dist = self.output('dist')
        for name in ['src', 'fork-docs', '.orca', '.git', 'unknown']:
            path = self.root / name
            path.mkdir()
            (path / 'keep').write_text('retained')
        preview = retain(self.policy, census=lambda: [])
        self.assertEqual(len(preview['wouldRemove']), 2)
        self.assertTrue(output.exists())
        self.assertTrue(dist.exists())
        actual = retain(self.policy, apply=True, census=lambda: [])
        self.assertEqual(len(actual['removed']), 2)
        self.assertFalse(output.exists())
        self.assertFalse(dist.exists())
        for name in ['src', 'fork-docs', '.orca', '.git', 'unknown']:
            self.assertEqual((self.root / name / 'keep').read_text(), 'retained')

    def test_age_count_and_physical_budget_retain_candidates(self):
        output = self.output()
        for change in [{'keepNewest': 1}, {'minAgeDays': 30}, {'maxBytes': 1}]:
            policy = {**self.policy, **change}
            self.assertEqual(retain(policy, apply=True, census=lambda: [])['removed'], [])
            self.assertTrue(output.exists())

    def test_active_and_unknown_processes_never_authorize_deletion(self):
        output = self.output()
        rows = [('/elsewhere', '/usr/bin/node', ['node', '--cwd=' + str(self.root)])]
        self.assertEqual(retain(self.policy, apply=True, census=lambda: rows)['removed'], [])
        def unavailable():
            raise PermissionError('synthetic')
        self.assertEqual(retain(self.policy, apply=True, census=unavailable)['removed'], [])
        self.assertTrue(output.exists())
        self.assertTrue(references_root(self.root, [(str(output), '/bin/sh', [])]))
        self.assertTrue(references_root(self.root, [('/', str(output / 'binary'), [])]))
        self.assertFalse(references_root(self.root, [('/', '/bin/sh', [str(self.root) + '-other'])]))

    def test_last_moment_process_or_file_change_preserves_candidate(self):
        output = self.output()
        calls = 0
        def census():
            nonlocal calls
            calls += 1
            if calls == 2:
                (output / 'new-file').write_text('concurrent write')
            return []
        self.assertEqual(retain(self.policy, apply=True, census=census)['removed'], [])
        self.assertEqual((output / 'new-file').read_text(), 'concurrent write')

    def test_symlink_root_is_skipped_and_nested_symlink_never_follows_target(self):
        marker = self.protected / 'keep'
        marker.write_text('protected')
        (self.root / 'out').symlink_to(self.protected, target_is_directory=True)
        self.assertEqual(retain(self.policy, apply=True, census=lambda: [])['removed'], [])
        (self.root / 'out').unlink()
        output = self.output()
        (output / 'linked').symlink_to(marker)
        old = time.time() - 14 * 86400
        os.utime(output / 'linked', (old, old), follow_symlinks=False)
        os.utime(output, (old, old))
        self.assertEqual(len(retain(self.policy, apply=True, census=lambda: [])['removed']), 1)
        self.assertEqual(marker.read_text(), 'protected')

    def test_protected_contents_paths_and_root_identity_are_refused(self):
        output = self.output()
        (output / 'fork-docs').mkdir()
        (output / 'fork-docs' / 'report').write_text('preserve')
        self.assertEqual(retain(self.policy, apply=True, census=lambda: [])['removed'], [])
        policy = copy.deepcopy(self.policy)
        policy['roots'][0]['inode'] += 1
        with self.assertRaises(ValueError):
            validate(policy)
        policy = copy.deepcopy(self.policy)
        policy['roots'][0]['outputs'] = ['../source']
        with self.assertRaises(ValueError):
            validate(policy)

    def test_snapshot_budget_is_global_across_reviewed_roots(self):
        self.output()
        second = self.base / 'reviewed-two'
        second.mkdir(mode=0o700)
        output = second / 'out'
        output.mkdir(mode=0o700)
        (output / 'reproducible.bin').write_bytes(b'x')
        old = time.time() - 14 * 86400
        os.utime(output / 'reproducible.bin', (old, old))
        os.utime(output, (old, old))
        info = second.stat()
        policy = copy.deepcopy(self.policy)
        policy['roots'][0]['outputs'] = ['out']
        policy['roots'].append({'id': 'second', 'path': str(second), 'device': info.st_dev,
                                'inode': info.st_ino, 'outputs': ['out']})
        with patch('operator_dev_retention.GLOBAL_SNAPSHOT_ENTRIES', 3):
            result = retain(policy, census=lambda: [])
        self.assertEqual(len(result['wouldRemove']), 1)
        self.assertEqual(result['snapshotEntries'], 3)
        self.assertEqual(result['skipped']['unverifiable-or-protected-tree'], 1)
        self.assertTrue(output.exists())

    def test_process_argv_budget_is_aggregate_not_per_process(self):
        proc = self.base / 'proc'
        proc.mkdir()
        for pid in ['10', '11']:
            entry = proc / pid
            entry.mkdir()
            (entry / 'stat').write_text(pid + ' (synthetic) ' + ' '.join(['1'] * 20))
            (entry / 'cmdline').write_bytes(b'synthetic\0')
            (entry / 'cwd').symlink_to(self.base)
            (entry / 'exe').symlink_to('/synthetic-executable')
        with patch('operator_dev_retention_processes.MAX_ARGV_BYTES', 15):
            with self.assertRaisesRegex(RuntimeError, 'process-argv-over-budget'):
                process_references(proc)


if __name__ == '__main__':
    unittest.main()
