import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight, ChevronUp, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'

export function MobileFileExplorerHeader({
  embedded,
  worktreeLabel,
  legacyListTruncated,
  displayRoot,
  canGoBack,
  canGoForward,
  onClose,
  onBackToSession,
  onBack,
  onForward,
  onUp,
  onNavigate
}: {
  embedded?: boolean
  worktreeLabel: string
  legacyListTruncated: boolean
  displayRoot: string
  canGoBack: boolean
  canGoForward: boolean
  onClose?: () => void
  onBackToSession: () => void
  onBack: () => void
  onForward: () => void
  onUp: () => void
  onNavigate: (path: string) => void
}) {
  const parts = displayRoot.split('/').filter(Boolean)
  return (
    <View>
      <View style={styles.topBar}>
        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          onPress={embedded ? onClose : onBackToSession}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={embedded ? 'Close files' : 'Back to session'}
        >
          {embedded ? (
            <X size={20} color={colors.textSecondary} strokeWidth={2.2} />
          ) : (
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          )}
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            Files
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {worktreeLabel}
            {legacyListTruncated ? ' - Showing first 5000' : ''}
          </Text>
        </View>
      </View>
      <View style={styles.navigationBar}>
        <Pressable
          onPress={onBack}
          disabled={!canGoBack}
          accessibilityRole="button"
          accessibilityLabel="Explorer back"
          style={styles.navigationButton}
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={onForward}
          disabled={!canGoForward}
          accessibilityRole="button"
          accessibilityLabel="Explorer forward"
          style={styles.navigationButton}
        >
          <ChevronRight size={18} color={colors.textSecondary} />
        </Pressable>
        <Pressable
          onPress={onUp}
          disabled={!displayRoot}
          accessibilityRole="button"
          accessibilityLabel="Explorer up"
          style={styles.navigationButton}
        >
          <ChevronUp size={18} color={colors.textSecondary} />
        </Pressable>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.breadcrumbScroll}
          contentContainerStyle={styles.breadcrumbContent}
        >
          <Pressable
            onPress={() => onNavigate('')}
            accessibilityRole="button"
            accessibilityLabel="Workspace root"
            style={styles.navigationButton}
          >
            <Text style={styles.breadcrumbText}>{worktreeLabel}</Text>
          </Pressable>
          {parts.map((segment, index) => {
            const path = parts.slice(0, index + 1).join('/')
            return (
              <Pressable
                key={path}
                onPress={() => onNavigate(path)}
                accessibilityRole="button"
                accessibilityLabel={`Open ${segment}`}
                style={styles.navigationButton}
              >
                <Text style={styles.breadcrumbText}>/ {segment}</Text>
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
      {displayRoot ? (
        <Text style={styles.viewScopeNote}>Explorer view only · terminal cwd unchanged</Text>
      ) : null}
    </View>
  )
}
