import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
const motion = vi.hoisted(() => ({
  reduced: false,
  timing: vi.fn((value: number) => value),
  cancel: vi.fn()
}))
vi.mock('../platform/use-reduced-motion', () => ({ useReducedMotionEnabled: () => motion.reduced }))
vi.mock('react-native-reanimated', async () => {
  const react = await import('react')
  return {
    default: { View: 'AnimatedView' },
    cancelAnimation: motion.cancel,
    useAnimatedStyle: (callback: () => unknown) => callback(),
    useSharedValue: (value: number) => react.useRef({ value }).current,
    withTiming: motion.timing
  }
})
import { MobileSectionReveal } from './MobileSectionReveal'
it('animates user section changes once, preserves mounts and stops for reduced motion', async () => {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<MobileSectionReveal sectionKey="board">Board</MobileSectionReveal>)
  })
  expect(motion.timing).not.toHaveBeenCalled()
  await act(async () =>
    tree.update(<MobileSectionReveal sectionKey="task">Task</MobileSectionReveal>)
  )
  expect(motion.timing).toHaveBeenCalledWith(1, { duration: 140 })
  expect(motion.timing).toHaveBeenCalledTimes(1)
  await act(async () =>
    tree.update(<MobileSectionReveal sectionKey="task">Refreshed server data</MobileSectionReveal>)
  )
  expect(motion.timing).toHaveBeenCalledTimes(1)
  motion.reduced = true
  await act(async () =>
    tree.update(<MobileSectionReveal sectionKey="report">Report</MobileSectionReveal>)
  )
  expect(motion.timing).toHaveBeenCalledTimes(1)
  expect(motion.cancel).toHaveBeenCalled()
  await act(async () => tree.unmount())
})
