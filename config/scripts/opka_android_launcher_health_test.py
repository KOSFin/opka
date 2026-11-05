"""Captured system ANR recovery contract; no ADB, emulator or application writes."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

from opka_android_launcher_health import PIXEL_HOME, ensure_pre_handoff_health, launcher_anr_close_target

CAPTURE = Path(__file__).parent / 'fixtures/android-webview-accessibility/pixel-launcher-anr.xml'
PACKAGE = 'com.kosfin.opka.mobile'
HEALTHY_XML = f'<hierarchy><node package="{PACKAGE}" text="Connect your desktop" /></hierarchy>'
RESUMED = f'topResumedActivity=ActivityRecord{{abc u0 {PACKAGE}/.MainActivity t1}}'


class LauncherHealthContract(unittest.TestCase):
    def test_captured_pixel_system_dialog_requires_exact_launcher_identity(self):
        tree = ET.parse(CAPTURE).getroot()
        self.assertEqual(launcher_anr_close_target(tree, PIXEL_HOME), (540, 961))
        with self.assertRaisesRegex(AssertionError, 'identity'):
            launcher_anr_close_target(tree, 'other.launcher/.Home')

    def test_opka_unknown_and_forged_dialogs_are_never_closed(self):
        source = CAPTURE.read_text()
        for xml in [source.replace('Pixel Launcher', 'Opka'),
                    source.replace('Pixel Launcher', 'Unknown app'),
                    source.replace('package="android"', f'package="{PACKAGE}"')]:
            with self.subTest(xml=xml[:20]):
                with self.assertRaises(AssertionError):
                    launcher_anr_close_target(ET.fromstring(xml), PIXEL_HOME)

    def test_no_anr_has_no_close_target(self):
        self.assertIsNone(launcher_anr_close_target(ET.fromstring(HEALTHY_XML), ''))

    def exercise(self, snapshots, *, emulator='1', resumed=RESUMED):
        calls = []

        def shell(*args):
            calls.append(args)
            if args[:2] == ('getprop', 'ro.kernel.qemu'):
                return emulator
            if args[:2] == ('cmd', 'package'):
                return PIXEL_HOME
            if args[:2] == ('dumpsys', 'activity'):
                return resumed
            return 'Status: ok'

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            shot = Mock()
            with patch('opka_android_launcher_health.ui_snapshot', side_effect=[
                    (ET.fromstring(xml), xml) for xml in snapshots]):
                ensure_pre_handoff_health(shell, shot, output, PACKAGE, now=lambda: 0, pause=lambda _: None)
            evidence = {path.name: path.read_text() for path in output.iterdir()}
        return calls, shot, evidence

    def test_recovers_once_then_requires_healthy_resumed_app_with_evidence(self):
        calls, shot, evidence = self.exercise([CAPTURE.read_text(), HEALTHY_XML])
        self.assertEqual([call for call in calls if call[:2] == ('input', 'tap')], [('input', 'tap', '540', '961')])
        self.assertIn(('am', 'start', '-W', '-n', f'{PACKAGE}/.MainActivity'), calls)
        self.assertEqual(shot.call_args_list[0].args, ('pre-handoff-health',))
        self.assertEqual(shot.call_args_list[-1].args, ('post-launcher-recovery',))
        self.assertEqual(evidence['pre-handoff-ui.xml'], CAPTURE.read_text())
        self.assertEqual(evidence['post-launcher-recovery-ui.xml'], HEALTHY_XML)

    def test_healthy_app_is_not_restarted_or_tapped(self):
        calls, _, _ = self.exercise([HEALTHY_XML])
        self.assertEqual(calls, [('dumpsys', 'activity', 'activities')])

    def test_recurrent_anr_and_non_emulator_refuse(self):
        with self.assertRaisesRegex(AssertionError, 'persisted or recurred'):
            self.exercise([CAPTURE.read_text(), CAPTURE.read_text()])
        with self.assertRaisesRegex(AssertionError, 'emulator-only'):
            self.exercise([CAPTURE.read_text()], emulator='0')

    def test_unknown_anr_and_unresumed_app_refuse(self):
        with self.assertRaisesRegex(AssertionError, 'Unknown or application'):
            self.exercise([CAPTURE.read_text().replace('Pixel Launcher', 'Opka')])
        with self.assertRaisesRegex(AssertionError, 'not resumed'):
            self.exercise([HEALTHY_XML], resumed='')

    def test_recovery_deadline_cannot_continue_to_handoff(self):
        clock = iter([0, 21])
        with tempfile.TemporaryDirectory() as directory:
            with patch('opka_android_launcher_health.ui_snapshot', return_value=(ET.parse(CAPTURE).getroot(), CAPTURE.read_text())):
                shell = Mock(side_effect=lambda *args: '1' if args[0] == 'getprop' else PIXEL_HOME if args[0] == 'cmd' else 'Status: ok')
                with self.assertRaisesRegex(AssertionError, 'did not resume'):
                    ensure_pre_handoff_health(shell, Mock(), Path(directory), PACKAGE, now=lambda: next(clock), pause=lambda _: None)


if __name__ == '__main__':
    unittest.main()
