export const ENGINE_ASSET_VERSION = '8.0.55'
export const ENGINE_ASSET_COMMIT = 'e6e5708e677adb2463d45accdd24bc9fd028ddd8'
export const ENGINE_MIT_NOTICE =
  'MIT License\n\nCopyright (c) 2025-2005.9 Luis Pater\nCopyright (c) 2025.9-present Router-For.ME\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.'
export const ENGINE_LICENSE_SHA256 =
  '879792e89cf1bdd6a8d446033ec87e30496f97dcafc4656dc53f641509b346a6'
export type EngineAssetPin = {
  target: string
  version: string
  url: string
  archiveSha256: string
  archiveBytes: number
  binaryMember: string
}
const PINS: Record<string, EngineAssetPin> = {
  'darwin-arm64': {
    target: 'darwin-arm64',
    version: '8.0.55',
    url: 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_darwin_aarch64.tar.gz',
    archiveSha256: 'ad4fac1948bba2310b8d4ef4b8d0f7983d06c1c8732b4ff1a889d31a718884e7',
    archiveBytes: 23241326,
    binaryMember: 'cli-proxy-api'
  },
  'darwin-x64': {
    target: 'darwin-x64',
    version: '8.0.55',
    url: 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_darwin_amd64.tar.gz',
    archiveSha256: 'd7845ac6055a09eef02b871c86461b112912c3282a90e84b6da4ab04e975a0b8',
    archiveBytes: 25183130,
    binaryMember: 'cli-proxy-api'
  },
  'linux-arm64': {
    target: 'linux-arm64',
    version: '8.0.55',
    url: 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_linux_aarch64_no-plugin.tar.gz',
    archiveSha256: 'd9bda4c7e5431b47b6f5a21dfb4fee110cf5eab0702cd54fa31a0da66868d4da',
    archiveBytes: 22615586,
    binaryMember: 'cli-proxy-api'
  },
  'linux-x64': {
    target: 'linux-x64',
    version: '8.0.55',
    url: 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_linux_amd64_no-plugin.tar.gz',
    archiveSha256: 'c6c570600e78ba9ef9773d6d7f787d9a25e62bc178b9daf8da07073ddbffc9b2',
    archiveBytes: 25099793,
    binaryMember: 'cli-proxy-api'
  },
  'win32-arm64': {
    target: 'win32-arm64',
    version: '8.0.55',
    url: 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_windows_aarch64.zip',
    archiveSha256: 'd1525c7ac48f8df4b2b97b3542357f8b3c59d85c377f8710e1a5313f7b1a7bbb',
    archiveBytes: 22761086,
    binaryMember: 'cli-proxy-api.exe'
  },
  'win32-x64': {
    target: 'win32-x64',
    version: '8.0.55',
    url: 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_windows_amd64.zip',
    archiveSha256: '137dde06f2e675f5be1b3ca7fecbaf2cec3c4d979e1930fa6016ea2777a03d13',
    archiveBytes: 25517047,
    binaryMember: 'cli-proxy-api.exe'
  }
}
export function getEngineAssetPin(
  platform: string = process.platform,
  arch: string = process.arch
): EngineAssetPin {
  const pin = PINS[`${platform}-${arch}`]
  if (!pin) {
    throw new Error('No pinned routing engine asset exists for this execution host')
  }
  return pin
}
