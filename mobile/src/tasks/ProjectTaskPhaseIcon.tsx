import { Circle, CircleCheck, ClipboardCheck, CirclePlay, TriangleAlert } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'

export function ProjectTaskPhaseIcon({ phase }: { phase: string }) {
  if (phase === 'done') {
    return <CircleCheck size={18} color={colors.statusGreen} />
  }
  if (phase === 'review' || phase === 'integration') {
    return <ClipboardCheck size={18} color={colors.statusPurple} />
  }
  if (phase === 'active' || phase === 'running' || phase === 'in_progress') {
    return <CirclePlay size={18} color={colors.statusAmber} />
  }
  if (phase === 'blocked') {
    return <TriangleAlert size={18} color={colors.statusRed} />
  }
  return <Circle size={18} color={colors.textSecondary} />
}
