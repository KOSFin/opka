import { useCallback, useRef, useState } from 'react'

export function useMobileFileExplorerNavigation() {
  const [displayRoot, setDisplayRoot] = useState('')
  const [history, setHistory] = useState<{ back: string[]; forward: string[] }>({
    back: [],
    forward: []
  })
  const displayRootRef = useRef(displayRoot)
  displayRootRef.current = displayRoot

  const navigateTo = useCallback((path: string) => {
    const previousRoot = displayRootRef.current
    if (path === previousRoot) {
      return
    }
    setHistory((previous) => ({
      back: [...previous.back, previousRoot].slice(-50),
      forward: []
    }))
    displayRootRef.current = path
    setDisplayRoot(path)
  }, [])

  const goBack = useCallback(() => {
    const target = history.back.at(-1)
    if (target === undefined) {
      return
    }
    setHistory({
      back: history.back.slice(0, -1),
      forward: [displayRootRef.current, ...history.forward].slice(0, 50)
    })
    displayRootRef.current = target
    setDisplayRoot(target)
  }, [history])

  const goForward = useCallback(() => {
    const target = history.forward[0]
    if (target === undefined) {
      return
    }
    setHistory({
      back: [...history.back, displayRootRef.current].slice(-50),
      forward: history.forward.slice(1)
    })
    displayRootRef.current = target
    setDisplayRoot(target)
  }, [history])

  const goUp = useCallback(() => {
    if (!displayRootRef.current) {
      return
    }
    navigateTo(displayRootRef.current.split('/').slice(0, -1).join('/'))
  }, [navigateTo])

  return { displayRoot, displayRootRef, history, navigateTo, goBack, goForward, goUp }
}
