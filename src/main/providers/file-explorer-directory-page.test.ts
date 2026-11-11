import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoundedFileExplorerDirectoryPage } from './file-explorer-directory-page'

const roots: string[] = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-explorer-page-'))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('bounded Explorer directory pages', () => {
  it('orders static directory and file ties across cursor pages without duplicate entries', async () => {
    const path = await root()
    await Promise.all([
      mkdir(join(path, '10-dir')),
      mkdir(join(path, '9-dir')),
      ...Array.from({ length: 270 }, (_, index) => writeFile(join(path, `${index}-file`), ''))
    ])
    const names: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await readBoundedFileExplorerDirectoryPage(
        path,
        'id:one',
        async (value) => value,
        {
          cursor: cursor ?? undefined,
          limit: 31
        }
      )
      expect(page.entries.length).toBeLessThanOrEqual(31)
      names.push(...page.entries.map((entry) => entry.name))
      cursor = page.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(9)
    expect(names).toHaveLength(272)
    expect(new Set(names).size).toBe(272)
    expect(names.slice(0, 4)).toEqual(['9-dir', '10-dir', '0-file', '1-file'])
  })

  it('rejects a changed directory, another selector and tampered cursors', async () => {
    const path = await root()
    await Promise.all(['a', 'b', 'c'].map((name) => writeFile(join(path, name), '')))
    const page = await readBoundedFileExplorerDirectoryPage(
      path,
      'id:one',
      async (value) => value,
      {
        limit: 1
      }
    )
    expect(page.nextCursor).toBeTruthy()
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:two', async (value) => value, {
        cursor: page.nextCursor ?? undefined,
        limit: 1
      })
    ).rejects.toThrow('Directory changed')
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
        cursor: `${page.nextCursor}x`,
        limit: 1
      })
    ).rejects.toThrow('Invalid directory page cursor')
    await writeFile(join(path, 'new'), '')
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
        cursor: page.nextCursor ?? undefined,
        limit: 1
      })
    ).rejects.toThrow('Directory changed')
  })

  it('rejects aborts and closes the directory for a subsequent read', async () => {
    const path = await root()
    await writeFile(join(path, 'a'), '')
    const controller = new AbortController()
    controller.abort()
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled')
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
    ).resolves.toMatchObject({
      entries: [{ name: 'a' }],
      nextCursor: null
    })
  })

  it('reserves at most four reads before awaited authorization', async () => {
    const path = await root()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = 0
    const authorize = async (value: string): Promise<string> => {
      entered++
      await gate
      return value
    }
    const pending = Array.from({ length: 4 }, () =>
      readBoundedFileExplorerDirectoryPage(path, 'id:one', authorize)
    )
    await expect(readBoundedFileExplorerDirectoryPage(path, 'id:one', authorize)).rejects.toThrow(
      'Too many directory page reads'
    )
    expect(entered).toBe(4)
    release()
    await expect(Promise.all(pending)).resolves.toHaveLength(4)
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
    ).resolves.toMatchObject({ nextCursor: null })
  })

  it('times out during an awaited host call and keeps its reservation until that call settles', async () => {
    const path = await root()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const authorize = async (value: string): Promise<string> => {
      await gate
      return value
    }
    const started = Date.now()
    const pending = readBoundedFileExplorerDirectoryPage(path, 'id:one', authorize)
    await expect(pending).rejects.toThrow('time limit')
    expect(Date.now() - started).toBeLessThan(3_800)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
    ).resolves.toMatchObject({ nextCursor: null })
  })

  it('rejects cancellation while authorization waits and does not return a partial page', async () => {
    const path = await root()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = new AbortController()
    const pending = readBoundedFileExplorerDirectoryPage(
      path,
      'id:one',
      async (value) => {
        await gate
        return value
      },
      { signal: controller.signal }
    )
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
    release()
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('releases a reserved slot when authorization fails before open', async () => {
    const path = await root()
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async () => {
        throw new Error('Denied')
      })
    ).rejects.toThrow('Denied')
    await expect(
      Promise.all(
        Array.from({ length: 4 }, () =>
          readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value)
        )
      )
    ).resolves.toHaveLength(4)
  })

  it('rejects cursor length and limit before scanning, and a changed canonical target after scanning', async () => {
    const path = await root()
    await writeFile(join(path, 'a'), '')
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, { limit: 129 })
    ).rejects.toThrow('limit')
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) => value, {
        cursor: 'x'.repeat(1501)
      })
    ).rejects.toThrow('cursor')
    const other = await root()
    let calls = 0
    await expect(
      readBoundedFileExplorerDirectoryPage(path, 'id:one', async (value) =>
        ++calls === 1 ? value : other
      )
    ).rejects.toThrow('Directory changed')
  })

  it('rejects an authorized symlink target switched between opening and page commit', async () => {
    const path = await root()
    const first = join(path, 'first')
    const second = join(path, 'second')
    const alias = join(path, 'alias')
    await mkdir(first)
    await mkdir(second)
    await symlink(first, alias)
    let calls = 0
    const authorize = async (value: string) => {
      if (++calls === 2) {
        await rm(alias)
        await symlink(second, alias)
      }
      return realpath(value)
    }
    await expect(readBoundedFileExplorerDirectoryPage(alias, 'id:one', authorize)).rejects.toThrow(
      'Directory changed'
    )
  })
})
