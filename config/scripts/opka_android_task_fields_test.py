"""Actual dialog hierarchy contract; labels must resolve to inputs, never their headings."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

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


if __name__ == '__main__':
    unittest.main()
