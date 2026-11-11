import React from 'react'

export function useAutomationCommandViewFence(hostKey: string): {
  capture(): number
  current(epoch: number): boolean
  advance(): void
} {
  const epoch = React.useRef(0)
  const mounted = React.useRef(false)
  React.useEffect(() => {
    mounted.current = true
    epoch.current += 1
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [hostKey])
  return {
    capture: () => epoch.current,
    current: (captured) => mounted.current && captured === epoch.current,
    advance: () => {
      epoch.current += 1
    }
  }
}
