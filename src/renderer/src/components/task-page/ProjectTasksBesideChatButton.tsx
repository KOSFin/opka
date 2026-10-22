import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'

export function ProjectTasksBesideChatButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        const state = useAppStore.getState()
        const enable = state.settings?.floatingTerminalEnabled
          ? Promise.resolve()
          : state.updateSettingsOrThrow({ floatingTerminalEnabled: true })
        void enable
          .then(() => {
            state.setFloatingWorkspaceContent('tasks')
            state.setFloatingWorkspacePanelOpen(true)
            state.setActiveView('terminal')
          })
          .catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : String(error))
          )
      }}
    >
      Open beside chat
    </Button>
  )
}
