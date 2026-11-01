import type { StyleProp, ViewStyle } from 'react-native'
import { useEffect, useRef, type ReactNode } from 'react'
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'

/** A user-selected section settles once; server refreshes never restart it. */
export function MobileSectionReveal({
  sectionKey,
  active = true,
  children,
  style
}: {
  sectionKey: string
  active?: boolean
  children: ReactNode
  style?: StyleProp<ViewStyle>
}) {
  const reducedMotion = useReducedMotionEnabled()
  const progress = useSharedValue(1)
  const previous = useRef({ sectionKey, active })
  useEffect(() => {
    const changed =
      previous.current.sectionKey !== sectionKey || (!previous.current.active && active)
    previous.current = { sectionKey, active }
    cancelAnimation(progress)
    if (changed && active && reducedMotion === false) {
      progress.value = 0
      progress.value = withTiming(1, { duration: 140 })
    } else {
      progress.value = 1
    }
    return () => cancelAnimation(progress)
  }, [sectionKey, active, reducedMotion, progress])
  const animatedStyle = useAnimatedStyle(
    () => ({
      opacity: 0.96 + progress.value * 0.04,
      transform: [{ translateY: (1 - progress.value) * 4 }]
    }),
    [progress]
  )
  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
}
