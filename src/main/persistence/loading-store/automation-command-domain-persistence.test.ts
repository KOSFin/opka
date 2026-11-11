import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import {
  serializeCompleteProfileStateDomains,
  serializeSelectiveProfileStateDomains
} from './profile-state-authority-writes'
import { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'

describe('opaque automation command domain serialization', () => {
  it('retains the definition and active claim through complete and selective writes', () => {
    const domain = {
      version: 1,
      definitions: [{ id: 'synthetic-command', command: { kind: 'program', executable: 'true' } }],
      activeClaims: [
        { automationId: 'synthetic-command', runId: 'synthetic-run', stage: 'acquiring' }
      ]
    }
    const state = { automations: [], automationRuns: [], automationCommandsV1: domain }
    const selective = serializeSelectiveProfileStateDomains(
      state,
      new Set(['automationCommandsV1'])
    )
    expect(selective).toEqual([{ domain: 'automationCommandsV1', payload: JSON.stringify(domain) }])

    const persisted = getDefaultPersistedState('/synthetic-profile')
    persisted.automationCommandsV1 = domain
    const serialization = new StateSerializationSecretHandlingOperations({
      state: persisted,
      protectedSecrets: new ProtectedSecretPersistence()
    })
    expect(
      serialization.buildStateDomainsToSave(new Set(['automationCommandsV1']))?.replacements
    ).toEqual([{ domain: 'automationCommandsV1', payload: JSON.stringify(domain) }])

    const complete = serializeCompleteProfileStateDomains(state, [], '')
    expect(JSON.parse(complete.payload.toString('utf8')).automationCommandsV1).toEqual(domain)
  })
})
