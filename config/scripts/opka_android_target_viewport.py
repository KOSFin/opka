"""Require visible Android geometry and reveal offscreen controls inside their observed container."""
import copy
import re
import time


def bounds(node):
    values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
    return values if len(values) == 4 and values[2] > values[0] and values[3] > values[1] else None


def visible_bounds(root, node):
    rectangle = bounds(node)
    window = next((bounds(item) for item in root.iter('node') if bounds(item)), None)
    if not rectangle or not window:
        return None
    clipped = [max(rectangle[0], window[0]), max(rectangle[1], window[1]),
               min(rectangle[2], window[2]), min(rectangle[3], window[3])]
    return clipped if clipped[2] > clipped[0] and clipped[3] > clipped[1] else None


def container_swipe(root, node, forward):
    parents = {child: parent for parent in root.iter() for child in parent}
    ancestor = parents.get(node)
    while ancestor is not None:
        area = visible_bounds(root, ancestor)
        if area and ancestor.get('class') in ('android.view.View', 'android.widget.ScrollView'):
            left, top, right, bottom = area
            if right - left >= 200 and bottom - top >= 200:
                # The observed form's edge avoids scrolling inside its multiline EditText.
                start, end = top + (bottom - top) * 4 // 5, top + (bottom - top) // 5
                if not forward:
                    start, end = end, start
                return [str(right - 2), str(start), str(right - 2), str(end), '350']
        ancestor = parents.get(ancestor)
    return None


def find_visible(snapshot, resolve, label, timeout, swipe, now=None, pause=None):
    now, pause = now or time.monotonic, pause or time.sleep
    deadline, attempts = now() + timeout, 0
    while now() < deadline:
        root = snapshot()
        node = resolve(root)
        if node is not None:
            area = visible_bounds(root, node)
            if area:
                result = copy.copy(node)
                result.set('bounds', f'[{area[0]},{area[1]}][{area[2]},{area[3]}]')
                return result
            if attempts < 4:
                gesture = container_swipe(root, node, attempts < 2)
                if gesture:
                    swipe(*gesture)
                    attempts += 1
        pause(0.35)
    raise AssertionError(f'UI did not expose visible {label!r}')
