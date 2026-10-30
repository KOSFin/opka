import { useLocalSearchParams } from 'expo-router'
import { MobileTasksScreen } from '../../../src/tasks/MobileTasksScreen'
import { MobileProjectTasksScreen } from '../../../src/tasks/MobileProjectTasksScreen'

export default function MobileTasksRoute() {
  const { taskSource } = useLocalSearchParams<{ taskSource?: string }>()
  return taskSource && taskSource !== 'project' ? (
    <MobileTasksScreen />
  ) : (
    <MobileProjectTasksScreen />
  )
}
