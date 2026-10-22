import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync } from 'node:fs'
import path from 'node:path'

// Test bundle only: never patch /Applications or the dependency store in place.
if (process.platform !== 'darwin') {
  throw new Error('The accessory-only audit bundle is macOS-specific')
}
const root = path.resolve(import.meta.dirname, '../..')
const source = path.join(root, 'node_modules/electron/dist/Electron.app')
const destination = path.join(root, '.tmp/fork-audit/Electron Background.app')
if (!existsSync(destination)) {
  // Preserve framework-relative links instead of redirecting them into node_modules.
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true })
}
const plist = path.join(destination, 'Contents/Info.plist')
chmodSync(plist, 0o644)
const plistCommand = (command) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { encoding: 'utf8' })
const sourceVersion = execFileSync(
  '/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleVersion', path.join(source, 'Contents/Info.plist')],
  { encoding: 'utf8' }
).trim()
if (plistCommand('Print :CFBundleVersion').trim() !== sourceVersion) {
  throw new Error('Audit Electron is stale; recreate only the inactive .tmp/fork-audit bundle')
}
let accessoryFlag
try {
  accessoryFlag = plistCommand('Print :LSUIElement').trim()
} catch {
  // Electron's upstream plist has no accessory-only flag.
}
if (accessoryFlag === undefined) {
  plistCommand('Add :LSUIElement bool true')
} else if (accessoryFlag !== 'true') {
  plistCommand('Set :LSUIElement true')
}
if (plistCommand('Print :LSUIElement').trim() !== 'true') {
  throw new Error('Could not make the test bundle accessory-only')
}
execFileSync('codesign', ['--deep', '--force', '--sign', '-', destination], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', '--strict', destination], { stdio: 'inherit' })
console.log(path.join(destination, 'Contents/MacOS/Electron'))
