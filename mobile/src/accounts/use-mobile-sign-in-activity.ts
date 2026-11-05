import { useCallback, useEffect, useRef } from 'react'

/** Keep browser-based sign-in alive while hidden without polling from the background. */
export function useMobileSignInActivity(active: boolean) {
  const current = useRef(active)
  current.current = active
  const waiting = useRef(new Set<() => void>())
  useEffect(() => {
    if (active) {
      for (const resume of waiting.current) {
        resume()
      }
    }
  }, [active])
  return useCallback((signal: AbortSignal): Promise<void> => {
    if (current.current || signal.aborted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const resume = () => {
        waiting.current.delete(resume)
        signal.removeEventListener('abort', resume)
        resolve()
      }
      waiting.current.add(resume)
      signal.addEventListener('abort', resume, { once: true })
      if (signal.aborted || current.current) {
        resume()
      }
    })
  }, [])
}
