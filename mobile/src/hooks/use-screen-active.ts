import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useAppActive } from './use-now'

export function useScreenActive(): boolean {
  const [focused, setFocused] = useState(false)
  const appActive = useAppActive()
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  return focused && appActive
}
