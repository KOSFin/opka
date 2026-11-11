import type { Dispatch, SetStateAction } from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getAccountsClaudeSearchEntries } from './accounts-claude-search'
import {
  getAccountsCodexSearchEntries,
  getAccountsGeminiSearchEntries,
  getAccountsCursorSearchEntries,
  getAccountsGrokSearchEntries,
  getAccountsAntigravitySearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsOpencodeSearchEntries,
  getAccountsZcodePlanSearchEntries
} from './accounts-search'
import { matchesSettingsSearch } from './settings-search'
import { GrokAccountsSection } from './GrokAccountsSection'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'
import { CursorAccountsSection } from './CursorAccountsSection'
import { ZcodePlanAccountsSection } from './ZcodePlanAccountsSection'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import { renderCodexAccountsSection } from './accounts-pane-codex-section'
import {
  renderGeminiAccountsSection,
  renderOpenCodeAccountsSection
} from './accounts-pane-provider-setting-sections'
import { MiniMaxAccountsSection } from './MiniMaxAccountsSection'
import { ManagedDataAccountsSection } from './ManagedDataAccountsSection'
import { RemoteAccountSignInSection } from './RemoteAccountSignInSection'
import type { UsageCredentialHost } from './usage-credential-host'
import type { UsageHostSettingsModel } from './use-usage-host-settings'
import {
  ClaudeIcon,
  GeminiIcon,
  MiniMaxIcon,
  OpenAIIcon,
  OpenCodeGoIcon
} from '../status-bar/icons'
import { AgentIcon } from '@/lib/agent-catalog'

type ProviderSectionsInput = {
  model: AccountsPaneSectionModel
  accountOwnerKey: string
  remoteServerLabel: string | null
  setEnrollmentRevision: Dispatch<SetStateAction<number>>
  usageCredentialHost: UsageCredentialHost
  usageHostSettings: UsageHostSettingsModel
  miniMaxRateLimits: ProviderRateLimits | null
}

export function buildAccountsProviderSections({
  model,
  accountOwnerKey,
  remoteServerLabel,
  setEnrollmentRevision,
  usageCredentialHost,
  usageHostSettings,
  miniMaxRateLimits
}: ProviderSectionsInput) {
  const {
    searchQuery,
    accountOwner,
    isRemoteAccountScope,
    accountRuntime,
    accountRuntimeSentenceLabel,
    recordFeatureInteraction
  } = model
  return [
    {
      key: 'opencode-data',
      matches: !searchQuery || /opencode|account/i.test(searchQuery),
      title: 'OpenCode',
      description: 'Saved accounts for OpenCode launches on this host.',
      icon: <AgentIcon agent="opencode" size={16} />,
      content: <ManagedDataAccountsSection provider="opencode" target={accountOwner} />
    },
    {
      key: 'devin-data',
      matches: !searchQuery || /devin|account/i.test(searchQuery),
      title: 'Devin',
      description: 'Saved accounts for Devin launches on this host.',
      icon: <AgentIcon agent="devin" size={16} />,
      content: <ManagedDataAccountsSection provider="devin" target={accountOwner} />
    },
    {
      key: 'claude',
      matches: matchesSettingsSearch(searchQuery, getAccountsClaudeSearchEntries()),
      title: 'Claude',
      description: 'Saved logins, default account and pool settings.',
      icon: <ClaudeIcon size={16} />,
      content: (
        <>
          {isRemoteAccountScope ? (
            <RemoteAccountSignInSection
              key={`sign-in:claude:${accountOwnerKey}`}
              provider="claude"
              target={accountOwner}
              hostLabel={remoteServerLabel ?? 'Server'}
              onComplete={() => setEnrollmentRevision((revision) => revision + 1)}
            />
          ) : null}
          {renderClaudeAccountsSection(model)}
        </>
      )
    },
    {
      key: 'codex',
      matches: matchesSettingsSearch(searchQuery, getAccountsCodexSearchEntries()),
      title: 'Codex',
      description: 'Saved logins, quotas, manual resets and pool settings.',
      icon: <OpenAIIcon size={16} />,
      content: (
        <>
          {isRemoteAccountScope ? (
            <RemoteAccountSignInSection
              key={`sign-in:codex:${accountOwnerKey}`}
              provider="codex"
              target={accountOwner}
              hostLabel={remoteServerLabel ?? 'Server'}
              onComplete={() => setEnrollmentRevision((revision) => revision + 1)}
            />
          ) : null}
          {renderCodexAccountsSection(model)}
        </>
      )
    },
    {
      key: 'gemini',
      matches: matchesSettingsSearch(searchQuery, getAccountsGeminiSearchEntries()),
      title: 'Gemini CLI',
      description: 'Existing Gemini CLI credentials for usage.',
      icon: <GeminiIcon size={16} />,
      content: renderGeminiAccountsSection(model)
    },
    {
      key: 'antigravity',
      matches: matchesSettingsSearch(searchQuery, getAccountsAntigravitySearchEntries()),
      title: 'Antigravity',
      description: 'Native agy account on the selected host.',
      icon: <AgentIcon agent="antigravity" size={16} />,
      content: (
        <AntigravityAccountsSection
          key={`antigravity:${accountOwnerKey}:${accountRuntime.runtime}:${accountRuntime.wslDistro ?? ''}`}
          owner={accountOwner}
          target={{ runtime: accountRuntime.runtime, wslDistro: accountRuntime.wslDistro }}
          label={accountRuntimeSentenceLabel}
        />
      )
    },
    {
      key: 'opencode-go',
      matches: matchesSettingsSearch(searchQuery, getAccountsOpencodeSearchEntries()),
      title: 'OpenCode Go',
      description: 'Credentials and usage settings for OpenCode Go.',
      icon: <OpenCodeGoIcon size={16} />,
      content: renderOpenCodeAccountsSection(model)
    },
    {
      key: 'minimax',
      matches: matchesSettingsSearch(searchQuery, getAccountsMiniMaxSearchEntries()),
      title: 'MiniMax',
      description: 'Host credentials and MiniMax usage.',
      icon: <MiniMaxIcon size={16} />,
      content: (
        <MiniMaxAccountsSection
          key={`minimax:${accountOwnerKey}`}
          host={usageCredentialHost}
          usageSettings={usageHostSettings}
          miniMaxRateLimits={isRemoteAccountScope ? null : miniMaxRateLimits}
          recordFeatureInteraction={recordFeatureInteraction}
        />
      )
    },
    {
      key: 'grok',
      matches: matchesSettingsSearch(searchQuery, getAccountsGrokSearchEntries()),
      title: 'Grok',
      description: 'Sign-in and usage for Grok.',
      icon: <AgentIcon agent="grok" size={16} />,
      content: <GrokAccountsSection />
    },
    {
      key: 'cursor',
      matches: matchesSettingsSearch(searchQuery, getAccountsCursorSearchEntries()),
      title: 'Cursor',
      description: 'Monthly plan usage from your Cursor sign-in.',
      icon: <AgentIcon agent="cursor" size={16} />,
      content: <CursorAccountsSection />
    },
    {
      key: 'zcode',
      matches: matchesSettingsSearch(searchQuery, getAccountsZcodePlanSearchEntries()),
      title: 'Zcode',
      description: 'Plan credentials and usage on the selected host.',
      icon: <AgentIcon agent="zcode" size={16} />,
      content: (
        <ZcodePlanAccountsSection
          key={`zcode:${accountOwnerKey}`}
          host={usageCredentialHost}
          usageSettings={usageHostSettings}
        />
      )
    }
  ]
}
