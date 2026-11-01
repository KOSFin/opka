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

    def test_provider_diagnosis_keeps_only_the_major_version(self):
        self.assertEqual(journey.webview_provider_major(
            'Current WebView package (name, version): (com.android.webview, 101.0.4951.61)'), 101)
        self.assertIsNone(journey.webview_provider_major('Current WebView package is null'))
        self.assertIsNone(journey.webview_provider_major('private-token'))

    def test_known_webview_refusal_is_captured_without_accepting_it_as_ready(self):
        root = screen("This device's WebView is too old to open the workspace safely.")
        self.assertTrue(journey.safe_failure_screen(root))
        self.assertIsNone(journey.onboarding_action(root))
        ET.SubElement(root, 'node', {'text': 'Pair'})
        self.assertFalse(journey.safe_failure_screen(root))

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


class HostListReadiness(unittest.TestCase):
    def test_captured_host_toolbar_is_ready_with_text_labels(self):
        fixture = Path(__file__).with_name('fixtures') / 'android-webview-accessibility/project-hierarchy.xml'
        self.assertTrue(journey.host_list_ready(ET.parse(fixture).getroot()))

    def test_accounts_header_and_tab_or_partial_toolbar_are_not_host_list(self):
        self.assertFalse(journey.host_list_ready(screen('Accounts', 'Accounts', 'Pools & switching')))
        self.assertFalse(journey.host_list_ready(screen('Accounts', 'Tasks')))
        root = screen('Workspace options', 'Accounts')
        ET.SubElement(root, 'node', {'content-desc': 'Tasks', 'enabled': 'false'})
        self.assertFalse(journey.host_list_ready(root))
        root[-1].set('enabled', 'true')
        self.assertTrue(journey.host_list_ready(root))


class NativeActionTargets(unittest.TestCase):
    def test_captured_accounts_radio_tab_wins_over_clickable_whole_page_ancestor(self):
        fixture = Path(__file__).with_name('fixtures') / 'android-webview-accessibility/accounts-pools.xml'
        root = ET.parse(fixture).getroot()
        tab = journey.actionable_match(root, 'Accounts')
        self.assertIsNotNone(tab)
        self.assertEqual(tab.get('class'), 'android.widget.RadioButton')
        self.assertEqual(tab.get('bounds'), '[44,231][527,304]')
        self.assertEqual(tab.get('text'), 'Accounts')

    def test_header_title_does_not_hide_clickable_accounts_tab(self):
        root = screen('Accounts')
        tab = ET.SubElement(root, 'node', {'clickable': 'true', 'enabled': 'true', 'bounds': '[1,2][3,4]'})
        ET.SubElement(tab, 'node', {'text': 'Accounts'})
        self.assertIs(journey.actionable_match(root, 'Accounts'), tab)

    def test_label_child_targets_nearest_enabled_clickable_ancestor(self):
        root = screen()
        outer = ET.SubElement(root, 'node', {'clickable': 'true', 'bounds': '[0,0][50,50]'})
        inner = ET.SubElement(outer, 'node', {'clickable': 'true', 'bounds': '[1,1][20,20]'})
        ET.SubElement(inner, 'node', {'content-desc': 'Native QA card, 0 attempts'})
        self.assertIs(journey.actionable_match(root, 'Native QA card', contains=True), inner)
        outer.set('enabled', 'false')
        self.assertIsNone(journey.actionable_match(root, 'Native QA card', contains=True))

    def test_saved_editor_wait_includes_disabled_title_but_not_card_title(self):
        root = screen('Native QA new card')
        self.assertFalse(journey.task_editor_present(root))
        editor = ET.SubElement(root, 'node', {'content-desc': 'Task title', 'enabled': 'false'})
        self.assertTrue(journey.task_editor_present(root))
        root.remove(editor)
        self.assertFalse(journey.task_editor_present(root))


if __name__ == '__main__':
    unittest.main()
