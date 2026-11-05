import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'

const MACH_O_MAGICS = ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']

export function isDarwinNativeProbeCi() {
  return (
    process.platform === 'darwin' &&
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_OS === 'macOS' &&
    userInfo().username === 'runner'
  )
}

export async function nativeProbeCliInvocation(cli, args) {
  const file = await open(cli, 'r')
  const prefix = Buffer.alloc(4)
  try {
    await file.read(prefix, 0, 4, 0)
  } finally {
    await file.close()
  }
  return prefix.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    MACH_O_MAGICS.includes(prefix.toString('hex'))
    ? { program: cli, args }
    : { program: process.execPath, args: [cli, ...args] }
}
export async function nativeProbeCliSha256(cli) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(cli)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}
