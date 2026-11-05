import type { ReactNode } from 'react'
// Native drawer gestures and shell clipboard/link verbs are outside this layout fixture.
export function BottomDrawer({ visible, children }: { visible: boolean; children: ReactNode }) {
  return visible ? <div role="dialog">{children}</div> : null
}
export const useClipboardWriter = () => ({ writeText: async () => {} })
export function openExternalLink(): void {}

export const useRouteHandoff = () => ({
  push: () => {
    throw new Error('Native navigation is outside this fixture')
  }
})
