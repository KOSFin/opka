"""Synthetic producer metadata; never downloads or rebuilds an APK."""
import copy
import unittest

from opka_android_built_run import PRODUCER, validate


class BuiltRunAdmission(unittest.TestCase):
    def records(self):
        return ({'id': 456, 'path': '.github/workflows/opka-release.yml', 'head_sha': 'a' * 40,
                 'head_branch': 'main', 'event': 'workflow_dispatch',
                 'repository': {'full_name': 'KOSFin/opka'}, 'head_repository': {'full_name': 'KOSFin/opka'}},
                {'total_count': 1, 'jobs': [{'name': PRODUCER, 'run_id': 456, 'head_sha': 'a' * 40, 'status': 'completed', 'conclusion': 'success'}]},
                {'total_count': 1, 'artifacts': [{'name': 'opka-android-' + 'a' * 40, 'expired': False, 'id': 123, 'workflow_run': {'id': 456, 'head_sha': 'a' * 40}}]})

    def test_successful_producer_can_be_reused_even_if_later_acceptance_failed(self):
        run, jobs, artifacts = self.records()
        run['conclusion'] = 'failure'
        self.assertEqual(validate(run, jobs, artifacts, 'a' * 40, 'opka-android-' + 'a' * 40), 123)

    def test_wrong_workflow_source_repository_and_unqualified_artifacts_fail_closed(self):
        mutations = [lambda r, j, a: r.update(path='.github/workflows/pr.yml'),
                     lambda r, j, a: r.update(head_sha='b' * 40),
                     lambda r, j, a: r.update(head_branch='feature'),
                     lambda r, j, a: r.update(event='pull_request'),
                     lambda r, j, a: r['repository'].update(full_name='foreign/opka'),
                     lambda r, j, a: r['head_repository'].update(full_name='foreign/opka'),
                     lambda r, j, a: j['jobs'][0].update(conclusion='failure'),
                     lambda r, j, a: j['jobs'][0].update(status='in_progress'),
                     lambda r, j, a: j.update(total_count=101),
                     lambda r, j, a: j['jobs'][0].update(run_id=789),
                     lambda r, j, a: j['jobs'][0].update(head_sha='b' * 40),
                     lambda r, j, a: a['artifacts'][0]['workflow_run'].update(id=789),
                     lambda r, j, a: a['artifacts'][0]['workflow_run'].update(head_sha='b' * 40),
                     lambda r, j, a: a.update(total_count=101),
                     lambda r, j, a: a['artifacts'][0].update(expired=True),
                     lambda r, j, a: a['artifacts'].append(copy.copy(a['artifacts'][0])),
                     lambda r, j, a: a['artifacts'][0].update(name='wrong')]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)), self.assertRaises(AssertionError):
                records = self.records()
                mutation(*records)
                validate(*records, 'a' * 40, 'opka-android-' + 'a' * 40)


if __name__ == '__main__':
    unittest.main()
