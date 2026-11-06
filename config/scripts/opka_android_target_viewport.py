"""Require visible Android geometry and reveal offscreen controls inside their observed container."""
import copy
import re
import time


def bounds(node):
    values = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
    return values if len(values) == 4 and values[2] > values[0] and values[3] > values[1] else None


def visible_bounds(root, node, for_tap=False):
    rectangle = bounds(node)
    window = next((bounds(item) for item in root.iter('node') if bounds(item)), None)
    if not rectangle or not window:
        return None
    clipped = [max(rectangle[0], window[0]), max(rectangle[1], window[1]),
               min(rectangle[2], window[2]), min(rectangle[3], window[3])]
    if for_tap:
        parents = {child: parent for parent in root.iter() for child in parent}
        regions, ancestor = [window], parents.get(node)
        while ancestor is not None:
            area = bounds(ancestor)
            if area and ancestor.get('scrollable') == 'true':
                regions.append(area)
            ancestor = parents.get(ancestor)
        center_x, center_y = (rectangle[0] + rectangle[2]) / 2, (rectangle[1] + rectangle[3]) / 2
        if any(not (area[0] <= center_x < area[2] and area[1] <= center_y < area[3]) for area in regions):
            return None
    return clipped if clipped[2] > clipped[0] and clipped[3] > clipped[1] else None


def interior_gesture(root, area, forward):
    window = next((bounds(item) for item in root.iter('node') if bounds(item)), None)
    if not window:
        return None
    width, height = window[2] - window[0], window[3] - window[1]
    left, top = max(area[0], window[0] + width // 10), max(area[1], window[1] + height // 10)
    right, bottom = min(area[2], window[2] - width // 10), min(area[3], window[3] - height // 10)
    if right - left < 120 or bottom - top < 120:
        return None
    start = top + (bottom - top) * (4 if forward else 1) // 5
    end = top + (bottom - top) * (1 if forward else 4) // 5
    fields = [bounds(item) for item in root.iter('node')
              if item.get('class') == 'android.widget.EditText' and bounds(item)]
    padding = max(8, width // 100)
    for x in [(left + right) // 2, left + (right - left) // 4, right - (right - left) // 4]:
        candidates = [start] + [edge + delta for field in fields if field[0] <= x < field[2]
                                for edge, delta in [(field[1], -padding), (field[3], padding)]]
        for y in sorted(set(candidates), key=lambda candidate: abs(candidate - start)):
            if not top <= y < bottom or (y - end if forward else end - y) < max(48, (bottom - top) // 5):
                continue
            # A gesture begun in an EditText scrolls the input instead of the surrounding form.
            if any(field[0] <= x < field[2] and field[1] <= y < field[3] for field in fields):
                continue
            return [str(x), str(y), str(x), str(end), '350']
    return None


def container_swipe(root, node, forward):
    parents = {child: parent for parent in root.iter() for child in parent}
    ancestor, candidates = parents.get(node), []
    while ancestor is not None:
        area = visible_bounds(root, ancestor)
        scrollable = ancestor.get('scrollable') == 'true'
        if area and (scrollable or ancestor.get('class') in ('android.view.View', 'android.widget.ScrollView')):
            if area[2] - area[0] >= 200 and area[3] - area[1] >= 200:
                candidates.append((not scrollable, area))
        ancestor = parents.get(ancestor)
    for _, area in sorted(candidates, key=lambda entry: entry[0]):
        gesture = interior_gesture(root, area, forward)
        if gesture:
            return gesture
    return None


def find_visible(snapshot, resolve, label, timeout, swipe, now=None, pause=None, reveal_forward=None, actionable=False):
    now, pause = now or time.monotonic, pause or time.sleep
    deadline, attempts = now() + timeout, 0
    while now() < deadline:
        root = snapshot()
        node = resolve(root)
        if node is not None:
            area = visible_bounds(root, node, for_tap=actionable)
            if area:
                result = copy.copy(node)
                result.set('bounds', f'[{area[0]},{area[1]}][{area[2]},{area[3]}]')
                return result
            if attempts < 4:
                direction = attempts < 2 if reveal_forward is None else reveal_forward
                gesture = container_swipe(root, node, direction)
                if gesture:
                    swipe(*gesture)
                    attempts += 1
        pause(0.35)
    raise AssertionError(f'UI did not expose visible {label!r}')
