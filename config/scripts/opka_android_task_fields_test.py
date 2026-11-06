"""Actual dialog hierarchy contract; labels must resolve to inputs, never their headings."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

from opka_android_target_viewport import bounds, container_swipe, find_visible, visible_bounds

from opka_android_task_fields import editable_task_field, task_editor_present


class TaskFieldContract(unittest.TestCase):
    def captured(self):
        return ET.parse(Path(__file__).with_name('fixtures') / 'android-webview-accessibility/new-task-dialog.xml').getroot()

    def test_all_three_captured_creation_fields_resolve_to_distinct_editable_inputs(self):
        root = self.captured()
        fields = [editable_task_field(root, label) for label in ['Task title', 'Task goal', 'Task acceptance criteria']]
        self.assertTrue(task_editor_present(root))
        self.assertTrue(all(node is not None and node.get('class') == 'android.widget.EditText' for node in fields))
        self.assertEqual(len({node.get('bounds') for node in fields}), 3)
        self.assertEqual(fields[0].get('bounds'), '[70,414][1010,543]')

    def test_named_input_is_preferred_and_existing_value_does_not_change_field_identity(self):
        root = self.captured()
        title = editable_task_field(root, 'Task title')
        title.set('text', 'Native QA new card')
        title.set('content-desc', 'Task title')
        self.assertIs(editable_task_field(root, 'Task title'), title)
        self.assertIsNone(editable_task_field(root, 'Unrelated input'))

    def test_disabled_field_keeps_editor_present_but_is_not_a_fill_target(self):
        root = self.captured()
        title = editable_task_field(root, 'Task title')
        title.set('enabled', 'false')
        self.assertTrue(task_editor_present(root))
        self.assertIsNone(editable_task_field(root, 'Task title'))

    def test_scrolled_zero_area_disabled_title_still_means_editor_is_open(self):
        root = self.captured()
        title = editable_task_field(root, 'Task title')
        title.set('bounds', '[0,0][0,0]')
        title.set('enabled', 'false')
        self.assertTrue(task_editor_present(root))
        self.assertIsNone(editable_task_field(root, 'Task title'))

    def test_heading_without_adjacent_input_or_duplicate_forms_are_refused(self):
        root = ET.fromstring('<hierarchy><node text="Title"/><node text="Save task" clickable="true"/></hierarchy>')
        self.assertIsNone(editable_task_field(root, 'Task title'))
        self.assertFalse(task_editor_present(root))
        root = self.captured()
        root.append(self.captured())
        self.assertIsNone(editable_task_field(root, 'Task title'))

    def test_edit_details_use_their_own_visible_label_and_saved_form_is_absent(self):
        root = self.captured()
        for node in root.iter('node'):
            if node.get('text') == 'Goal':
                node.set('text', 'Plan and task details')
        self.assertIsNotNone(editable_task_field(root, 'Task details'))
        self.assertIsNone(editable_task_field(root, 'Task goal'))
        self.assertFalse(task_editor_present(ET.fromstring('<hierarchy><node text="Native QA edited card"/></hierarchy>')))



class TargetViewportContract(unittest.TestCase):
    def captured(self):
        return ET.parse(Path(__file__).with_name('fixtures') / 'android-webview-accessibility/edit-task-offscreen.xml').getroot()

    def save(self, root):
        return next(node for node in root.iter('node') if node.get('text') == 'Save task')

    def test_captured_zero_area_save_is_not_tappable_and_scroll_uses_its_real_form(self):
        root = self.captured()
        target = self.save(root)
        self.assertIsNone(bounds(target))
        self.assertIsNone(visible_bounds(root, target))
        self.assertEqual(container_swipe(root, target, True), ['540', '1541', '540', '1298', '350'])

    def test_captured_accounts_swipe_stays_inside_content_not_system_navigation_edges(self):
        root = ET.parse(Path(__file__).with_name('fixtures') / 'android-webview-accessibility/accounts-offscreen.xml').getroot()
        target = next(node for node in root.iter('node') if node.get('text') == 'codex pool mode')
        self.assertIsNone(bounds(target))
        gesture = list(map(int, container_swipe(root, target, True)))
        self.assertGreaterEqual(gesture[0], 108)
        self.assertLessEqual(gesture[0], 972)
        self.assertGreater(gesture[1], gesture[3])
        self.assertGreaterEqual(gesture[3], 850)
        self.assertLessEqual(gesture[1], 1728)

    def test_real_scrollable_ancestor_wins_over_a_nearer_generic_view(self):
        root = ET.fromstring('<hierarchy><node bounds="[0,0][1000,1600]" class="android.widget.ScrollView" scrollable="true"><node bounds="[100,800][900,1500]" class="android.view.View"><node bounds="[0,0][0,0]" text="Target"/></node></node></hierarchy>')
        target = list(root.iter('node'))[-1]
        gesture = list(map(int, container_swipe(root, target, True)))
        self.assertLess(gesture[3], 800)
        self.assertTrue(100 <= gesture[0] <= 900)

    def test_form_swipe_starts_outside_multiline_input_and_system_edges(self):
        root = self.captured()
        gesture = list(map(int, container_swipe(root, self.save(root), True)))
        self.assertTrue(108 <= gesture[0] <= 972)
        for node in root.iter('node'):
            area = bounds(node)
            if node.get('class') == 'android.widget.EditText' and area:
                self.assertFalse(area[0] <= gesture[0] < area[2] and area[1] <= gesture[1] < area[3])

    def test_input_covering_every_safe_start_refuses_a_gesture(self):
        root = ET.fromstring('<hierarchy><node bounds="[0,0][1000,1600]" class="android.widget.ScrollView" scrollable="true"><node class="android.widget.EditText" bounds="[0,0][1000,1600]"/><node bounds="[0,0][0,0]" text="Target"/></node></hierarchy>')
        target = list(root.iter('node'))[-1]
        self.assertIsNone(container_swipe(root, target, True))
        self.assertIsNone(container_swipe(root, target, False))

    def test_scroll_then_fresh_observation_must_expose_real_positive_target(self):
        hidden, shown = self.captured(), self.captured()
        self.save(shown).set('bounds', '[70,1450][490,1550]')
        snapshots, gestures = iter([hidden, shown]), []
        clock = iter(range(10))
        target = find_visible(lambda: next(snapshots), self.save, 'Save task', 8,
                              lambda *args: gestures.append(args), now=lambda: next(clock), pause=lambda _: None)
        self.assertEqual(target.get('bounds'), '[70,1450][490,1550]')
        self.assertEqual(len(gestures), 1)
        self.assertIsNone(bounds(self.save(hidden)))

    def test_unrevealed_target_stops_after_four_scrolls_without_zero_area_click(self):
        root, gestures, clock = self.captured(), [], iter(range(20))
        with self.assertRaisesRegex(AssertionError, 'visible'):
            find_visible(lambda: root, self.save, 'Save task', 8,
                         lambda *args: gestures.append(args), now=lambda: next(clock), pause=lambda _: None)
        self.assertEqual(len(gestures), 4)
        self.assertEqual(gestures[0][1:4:2], ('1541', '1298'))
        self.assertEqual(gestures[-1][1:4:2], ('1298', '1620'))

    def test_directional_reveal_continues_past_four_only_for_new_geometry(self):
        fixture = Path(__file__).with_name('fixtures') / 'android-webview-accessibility/accounts-deep-offscreen.xml'
        frames = []
        for offset in range(6):
            root = ET.parse(fixture).getroot()
            marker = next(node for node in root.iter('node') if node.get('text') == 'Use automatic pool')
            marker.set('bounds', f'[105,{979 - offset * 40}][811,{1026 - offset * 40}]')
            if offset == 5:
                next(node for node in root.iter('node') if node.get('text') == 'codex pool mode').set('bounds', '[105,1660][947,1779]')
            frames.append(root)
        gestures, clock = [], iter(range(50))
        def snapshot():
            return frames[min(len(gestures), len(frames) - 1)]
        target = find_visible(snapshot, lambda root: next(node for node in root.iter('node') if node.get('text') == 'codex pool mode'),
                              'codex pool mode', 20, lambda *args: gestures.append(args),
                              now=lambda: next(clock), pause=lambda _: None, reveal_forward=True)
        self.assertEqual(target.get('bounds'), '[105,1660][947,1779]')
        self.assertEqual(len(gestures), 5)

    def test_directional_reveal_does_not_extend_for_text_noise_or_repeated_geometry(self):
        root = self.captured()
        gestures, clock, updates = [], iter(range(50)), [0]
        marker = ET.SubElement(root, 'node', {'text': '0', 'bounds': '[1,1][20,20]'})
        def snapshot():
            updates[0] += 1
            marker.set('text', str(updates[0]))
            return root
        with self.assertRaisesRegex(AssertionError, 'visible'):
            find_visible(snapshot, self.save, 'Save task', 20, lambda *args: gestures.append(args),
                         now=lambda: next(clock), pause=lambda _: None, reveal_forward=True)
        self.assertEqual(len(gestures), 4)

    def test_directional_reveal_does_not_extend_for_cycling_geometry(self):
        root, gestures, clock = self.captured(), [], iter(range(50))
        marker = ET.SubElement(root, 'node', {'bounds': '[1,1][20,20]'})
        def snapshot():
            offset = len(gestures) % 2
            marker.set('bounds', f'[1,{1 + offset}][20,{20 + offset}]')
            return root
        with self.assertRaisesRegex(AssertionError, 'visible'):
            find_visible(snapshot, self.save, 'Save task', 20, lambda *args: gestures.append(args),
                         now=lambda: next(clock), pause=lambda _: None, reveal_forward=True)
        self.assertEqual(len(gestures), 4)

    def test_directional_reveal_has_an_eight_gesture_ceiling_even_with_progress(self):
        root, gestures, clock, updates = self.captured(), [], iter(range(60)), [0]
        marker = ET.SubElement(root, 'node', {'bounds': '[1,1][20,20]'})
        def snapshot():
            updates[0] += 1
            marker.set('bounds', f'[1,{updates[0]}][20,{updates[0] + 20}]')
            return root
        with self.assertRaisesRegex(AssertionError, 'visible'):
            find_visible(snapshot, self.save, 'Save task', 24, lambda *args: gestures.append(args),
                         now=lambda: next(clock), pause=lambda _: None, reveal_forward=True)
        self.assertEqual(len(gestures), 8)

    def test_clipped_targets_are_intersected_with_the_actual_window(self):
        root = ET.fromstring('<hierarchy><node bounds="[0,0][100,100]"><node bounds="[90,90][200,200]"/></node></hierarchy>')
        target = list(root.iter('node'))[-1]
        self.assertEqual(visible_bounds(root, target), [90, 90, 100, 100])
        target.set('bounds', '[100,100][200,200]')
        self.assertIsNone(visible_bounds(root, target))

if __name__ == '__main__':
    unittest.main()
