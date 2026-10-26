export function forkInstallerProbes(env: NodeJS.ProcessEnv) {
  const version = env.ORCA_FORK_UPDATE_TARGET_VERSION
  const sha256 = env.ORCA_FORK_UPDATE_TARGET_SHA256
  if (version !== undefined || sha256 !== undefined) {
    if (
      !version ||
      !sha256 ||
      !/^\d+\.\d+\.\d+-rc\.[1-9]\d*$/.test(version) ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error('Installer probe requires an explicit beta version and SHA256')
    }
    return [{ version, sha256 }]
  }
  return [
    {
      version: '1.4.236-rc.3',
      sha256: 'f846b6de8897336cbf54b7c18b2dbfd6ff14fc650515ae7498677422d327d454'
    },
    {
      version: '1.4.236-rc.2',
      sha256: '6351f50deaacef47071748086ed35c274d402409cf6d8157b65459a9865c5751'
    },
    {
      version: '1.4.236-rc.1',
      sha256: '1ccc3e4234e68056fb28ce0fc56227979bb4de2cb091d1c7e3b9bef92c6789c1'
    }
  ]
}
