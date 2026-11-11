import { useState } from 'react'
import { X } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import { getProjectGroupExecutionHostIdForRows } from '../../../src/shared/sidebar-list/host-filtering'
import { BottomDrawer } from '../components/BottomDrawer'
import { MobileRepoIcon } from '../components/MobileRepoIcon'
import { PickerModal } from '../components/PickerModal'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import type { HostRepoCatalogRow } from './host-screen-reply-schema'
import {
  useMobileProjectGroupManager,
  type ManagedProjectGroup
} from './use-mobile-project-group-manager'

const ICONS = ['Folder', 'Rocket', 'Code2', 'Briefcase', 'Layers', 'Wrench']
const repoKey = (repo: HostRepoCatalogRow) =>
  JSON.stringify([repo.id, repo.path, getRepoExecutionHostId(repo)])

export function MobileProjectGroupManager({
  client,
  connection,
  target,
  onClose,
  onSaved
}: {
  client: RpcClient | null
  connection: string
  target: ManagedProjectGroup
  onClose: () => void
  onSaved: () => void
}) {
  const model = useMobileProjectGroupManager(client, connection, target, onSaved)
  const [iconOpen, setIconOpen] = useState(false)
  const [repoOpen, setRepoOpen] = useState(false)
  const [destinationOpen, setDestinationOpen] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<HostRepoCatalogRow | null>(null)
  const disabled = model.busy || connection !== 'connected' || !model.group
  const sourceHost = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null
  const destinations = model.groups.filter(
    (group) =>
      getProjectGroupExecutionHostIdForRows(group, LOCAL_EXECUTION_HOST_ID) === sourceHost &&
      model.groups.filter((item) => item.id === group.id).length === 1
  )
  return (
    <>
      <BottomDrawer
        visible
        onClose={() => {
          if (!model.busy) {
            onClose()
          }
        }}
        contentScrollable
      >
        <View style={styles.content}>
          <View style={styles.heading}>
            <Text style={styles.title} numberOfLines={1}>
              Project · {target.title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close project settings"
              disabled={model.busy}
              style={styles.close}
              onPress={onClose}
            >
              <X size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
          <Text style={styles.meta}>
            Rename and choose an icon without changing repositories or chats.
          </Text>
          {model.error ? <Text style={styles.error}>{model.error}</Text> : null}
          <TextInput
            accessibilityLabel="Project name"
            value={model.name}
            editable={!disabled}
            onChangeText={model.setName}
            placeholder="Project name"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose project icon"
            disabled={disabled}
            onPress={() => setIconOpen(true)}
            style={[styles.row, disabled && styles.disabled]}
          >
            <MobileRepoIcon repoIcon={model.icon ?? null} size={18} />
            <Text style={styles.text}>Project icon</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save project settings"
            disabled={disabled}
            onPress={() => void model.save()}
            style={[styles.row, disabled && styles.disabled]}
          >
            <Text style={styles.text}>{model.busy ? 'Saving…' : 'Save project settings'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Move repository to a project"
            disabled={disabled}
            onPress={() => {
              void model.prepareMove().then((ready) => {
                if (ready) {
                  setRepoOpen(true)
                }
              })
            }}
            style={[styles.row, disabled && styles.disabled]}
          >
            <Text style={styles.text}>Move repository…</Text>
          </Pressable>
          <Text style={styles.meta}>
            Choose a repository, then its destination project on the same execution host. Moving it
            out of a project keeps the repository and chats.
          </Text>
        </View>
      </BottomDrawer>
      <PickerModal
        visible={iconOpen}
        title="Project icon"
        selected={model.icon?.type === 'lucide' ? model.icon.name : ''}
        options={[
          { value: '', label: 'Default folder' },
          ...ICONS.map((name) => ({ value: name, label: name }))
        ]}
        onClose={() => setIconOpen(false)}
        onSelect={(value) => model.setIcon(value ? { type: 'lucide', name: value } : null)}
        zIndex={20}
      />
      <PickerModal
        visible={repoOpen}
        title="Move repository"
        selected=""
        options={model.repos.map((repo) => ({
          value: repoKey(repo),
          label: `${repo.displayName} · ${repo.path ?? ''}`
        }))}
        onClose={() => setRepoOpen(false)}
        onSelect={(value) => {
          const chosen = model.repos.find((repo) => repoKey(repo) === value)
          if (chosen) {
            setSelectedRepo(chosen)
            setDestinationOpen(true)
          }
        }}
        zIndex={20}
      />
      <PickerModal
        visible={destinationOpen && selectedRepo !== null}
        title="Destination project"
        selected={destinations.some((group) => group.id === target.id) ? target.id : ''}
        options={[
          { value: '', label: 'No project' },
          ...destinations.map((group) => ({ value: group.id, label: group.name }))
        ]}
        onClose={() => setDestinationOpen(false)}
        onSelect={(value) => {
          if (selectedRepo) {
            void model.move(selectedRepo, value || null)
          }
        }}
        zIndex={20}
      />
    </>
  )
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  text: { color: colors.textPrimary, fontSize: typography.bodySize, flex: 1 },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18 },
  error: { color: colors.statusRed, fontSize: typography.bodySize },
  input: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    backgroundColor: colors.bgPanel,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: spacing.md
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card
  },
  disabled: { opacity: 0.5 }
})
