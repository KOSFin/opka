"""Resolve task form inputs from accessible names or captured adjacent visible labels."""
LABELS = {
    'Task title': 'Title',
    'Task goal': 'Goal',
    'Task details': 'Plan and task details',
    'Task acceptance criteria': 'Acceptance criteria · one per line'
}


def labels(node):
    return (node.get('text', ''), node.get('content-desc', ''))


def editable_task_field(root, label, require_enabled=True):
    def usable(node):
        return node.get('class') == 'android.widget.EditText' and (not require_enabled or node.get('enabled', 'true') == 'true')
    named = [node for node in root.iter('node') if usable(node) and label in labels(node)]
    if named:
        return named[0] if len(named) == 1 else None
    visible = LABELS.get(label)
    if visible is None:
        return None
    candidates = []
    for parent in root.iter():
        children = list(parent)
        for index, node in enumerate(children[:-1]):
            if visible in labels(node) and usable(children[index + 1]):
                candidates.append(children[index + 1])
    return candidates[0] if len(candidates) == 1 else None


def task_editor_present(root):
    return any('Task title' in labels(node) for node in root.iter('node')) or editable_task_field(root, 'Task title', require_enabled=False) is not None
