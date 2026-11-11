module.exports = {
  app: {
    getPath: () => '/tmp',
    getName: () => 'orca-disposable-fixture',
    getVersion: () => '0.0.0-fixture',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('Fixture must not encrypt credentials') },
    decryptString: () => { throw new Error('Fixture must not decrypt credentials') }
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}
