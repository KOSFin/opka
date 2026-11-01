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
        self.assertEqual(container_swipe(root, target, True), ['1008', '1774', '1008', '1336', '350'])

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
        self.assertEqual(gestures[0][1:4:2], ('1774', '1336'))
        self.assertEqual(gestures[-1][1:4:2], ('1336', '1774'))

    def test_clipped_targets_are_intersected_with_the_actual_window(self):
        root = ET.fromstring('<hierarchy><node bounds="[0,0][100,100]"><node bounds="[90,90][200,200]"/></node></hierarchy>')
        target = list(root.iter('node'))[-1]
        self.assertEqual(visible_bounds(root, target), [90, 90, 100, 100])
        target.set('bounds', '[100,100][200,200]')
        self.assertIsNone(visible_bounds(root, target))

if __name__ == '__main__':
    unittest.main()
