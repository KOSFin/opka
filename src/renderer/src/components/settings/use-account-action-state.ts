import { useRef, useState } from 'react'

export function useAccountActionState<Action extends string>(
  ownerView: { key: string },
  isCurrentOwner: () => boolean
): {
  action: Action | 'idle'
  start: (action: Action) => number
  finish: (sequence: number) => void
} {
  const [state, setState] = useState<{ ownerView: { key: string }; action: Action | 'idle' }>({
    ownerView,
    action: 'idle'
  })
  const sequenceRef = useRef(0)
  const start = (action: Action): number => {
    if (!isCurrentOwner()) {
      return -1
    }
    const sequence = ++sequenceRef.current
    setState({ ownerView, action })
    return sequence
  }
  const finish = (sequence: number): void => {
    if (isCurrentOwner() && sequenceRef.current === sequence) {
      setState({ ownerView, action: 'idle' })
    }
  }
  return { action: state.ownerView === ownerView ? state.action : 'idle', start, finish }
}
