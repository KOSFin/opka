"""Pure navigation/diagnostic policy tests; no ADB, host, APK or provider is launched."""
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('journey', Path(__file__).with_name('opka-android-ui-journey.py'))
journey = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journey)


def screen(*labels):
    root = ET.Element('hierarchy')
    for label in labels:
        ET.SubElement(root, 'node', {'text': label, 'enabled': 'true'})
    return root


class NormalOnboarding(unittest.TestCase):
    def test_clean_pairing_uses_visible_session_and_notification_choices_before_host(self):
        self.assertEqual(journey.onboarding_action(screen(
            'How should sessions open?', 'Open sessions in Chat UI')), 'Open sessions in Chat UI')
        self.assertEqual(journey.onboarding_action(screen(
            'Don’t miss when an agent needs you', 'Skip notifications for now')), 'Skip notifications for now')
        self.assertEqual(journey.onboarding_action(screen('Accounts')), 'ready')

    def test_connecting_and_disabled_choices_do_not_skip_to_host(self):
        self.assertIsNone(journey.onboarding_action(screen('Connecting…')))
        root = screen('How should sessions open?')
        ET.SubElement(root, 'node', {'content-desc': 'Open sessions in Chat UI', 'enabled': 'false'})
        self.assertIsNone(journey.onboarding_action(root))

    def test_failure_capture_refuses_pairing_and_unknown_connection_surfaces(self):
        for root in [screen('Pair with this desktop?', 'Pair'),
                     screen('Connection failed', 'private-token'),
                     screen('Accounts', 'Pair')]:
            self.assertFalse(journey.safe_failure_screen(root))
        self.assertTrue(journey.safe_failure_screen(screen(
            'How should sessions open?', 'Open sessions in Chat UI')))
        self.assertTrue(journey.safe_failure_screen(screen('Accounts')))


if __name__ == '__main__':
    unittest.main()
