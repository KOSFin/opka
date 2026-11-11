import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { captureHiddenGitScreenshot, runIsolatedFixtureGit } from './helpers/git-synthetic-journey'

test.use({
  orcaAppExtraEnv: {
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_TELEMETRY_DISABLED: '1',
    ORCA_DIAGNOSTICS_DISABLED: '1',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GLAB_TOKEN: '',
    GITLAB_TOKEN: ''
  },
  trace: 'off',
  screenshot: 'off'
})

const evidenceDir = process.env.ORCA_GIT_HIDDEN_EVIDENCE_DIR
if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
  throw new Error('ORCA_GIT_HIDDEN_EVIDENCE_DIR must be an absolute private evidence path')
}

test.describe('synthetic project trackers', () => {
  test.use({ seedTestRepo: false })

  test('selected GitLab projects show the MR source, checks and discussion without a global repo dump', async ({
    electronApp,
    orcaPage: page,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(180_000)
    mkdirSync(evidenceDir, { recursive: true })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-git-trackers-'))
    registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
    const gitHome = path.join(root, 'git-home')
    mkdirSync(gitHome)
    const repoPaths = [path.join(root, 'tracker-a'), path.join(root, 'tracker-b')]
    for (const [index, repoPath] of repoPaths.entries()) {
      mkdirSync(repoPath)
      await runIsolatedFixtureGit(repoPath, gitHome, ['init', '-q'])
      await runIsolatedFixtureGit(repoPath, gitHome, [
        'remote',
        'add',
        'origin',
        `https://gitlab.example/team/tracker-${index ? 'b' : 'a'}.git`
      ])
    }
    await page.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    const hiddenBefore = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
    expect(hiddenBefore).toBe(true)
    const receiptPath = path.join(evidenceDir, 'gitlab-selected-project-ipc.jsonl')
    writeFileSync(receiptPath, '')
    await electronApp.evaluate(
      ({ ipcMain }, { repoPaths }) => {
        ipcMain.removeHandler('preflight:check')
        ipcMain.handle('preflight:check', () => ({
          git: { installed: true },
          gh: { installed: false, authenticated: false },
          glab: { installed: true, authenticated: true }
        }))
        const calls: { method: string; repoPath: string; iid?: number }[] = []
        Reflect.set(globalThis, '__gitlabSyntheticCalls', calls)
        Reflect.set(globalThis, '__gitlabSyntheticRepoPaths', repoPaths)
        const itemFor = (repoPath: string) => {
          const first = repoPath === repoPaths[0]
          const letter = first ? 'a' : 'b'
          const number = first ? 11 : 22
          return {
            id: `mr-${letter}`,
            type: 'mr',
            number,
            title: `Synthetic MR ${letter.toUpperCase()}`,
            state: 'opened',
            url: `https://gitlab.example/team/tracker-${letter}/-/merge_requests/${number}`,
            labels: ['synthetic'],
            updatedAt: '2026-11-01T00:00:00Z',
            author: 'fixture',
            branchName: `feature/${letter}`,
            baseRefName: 'main',
            projectRef: { host: 'gitlab.example', path: `team/tracker-${letter}` }
          }
        }
        ipcMain.removeHandler('gitlab:listMRs')
        ipcMain.handle('gitlab:listMRs', async (_event, args: { repoPath: string }) => {
          if (!repoPaths.includes(args.repoPath)) {
            throw new Error('Foreign repository selector')
          }
          calls.push({ method: 'listMRs', repoPath: args.repoPath })
          return { items: [itemFor(args.repoPath)] }
        })
        ipcMain.removeHandler('gitlab:listIssues')
        ipcMain.handle('gitlab:listIssues', () => ({ items: [] }))
        ipcMain.removeHandler('gitlab:workItemDetails')
        ipcMain.handle(
          'gitlab:workItemDetails',
          async (_event, args: { repoPath: string; iid: number }) => {
            if (!repoPaths.includes(args.repoPath)) {
              throw new Error('Foreign repository selector')
            }
            calls.push({ method: 'workItemDetails', repoPath: args.repoPath, iid: args.iid })
            return {
              item: itemFor(args.repoPath),
              body: 'Synthetic description with linked issue #7',
              comments: [
                {
                  id: 1,
                  author: 'reviewer',
                  authorAvatarUrl: '',
                  body: 'Synthetic discussion',
                  createdAt: '2026-11-01T00:00:00Z',
                  url: 'https://gitlab.example/discussion/1'
                }
              ],
              files: [
                {
                  path: 'src/feature.ts',
                  status: 'modified',
                  additions: 2,
                  deletions: 1,
                  isBinary: false
                }
              ],
              pipelineJobs: [
                {
                  id: 7,
                  name: 'synthetic-check',
                  stage: 'test',
                  status: 'success',
                  webUrl: 'https://gitlab.example/job/7',
                  duration: 2
                }
              ]
            }
          }
        )
      },
      { repoPaths }
    )
    const ids = await page.evaluate(async (paths) => {
      const addedRepos = []
      for (const path of paths) {
        const added = await window.api.repos.add({ path })
        if ('error' in added) {
          throw new Error(added.error)
        }
        addedRepos.push(added.repo)
      }
      await window
        .__store!.getState()
        .fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
      await window.__store!.getState().awaitLocalRepoCatalogSettlement()
      const repos = addedRepos.map((addedRepo) => {
        const repo = window
          .__store!.getState()
          .repos.find(
            (entry) =>
              entry.id === addedRepo.id &&
              entry.path === addedRepo.path &&
              !entry.connectionId &&
              (entry.executionHostId == null || entry.executionHostId === 'local')
          )
        if (!repo) {
          throw new Error('Exact local tracker repo not loaded')
        }
        return repo
      })
      return repos.map((repo) => ({
        id: repo?.id,
        path: repo?.path,
        executionHostId: repo?.executionHostId
      }))
    }, repoPaths)
    writeFileSync(
      path.join(evidenceDir, 'gitlab-tracker-repo-owners.json'),
      `${JSON.stringify(ids, null, 2)}\n`
    )
    expect(new Set(ids.map((repo) => repo.id)).size).toBe(2)
    expect(new Set(ids.map((repo) => repo.path)).size).toBe(2)
    for (const [index, repo] of ids.entries()) {
      expect(realpathSync(repo.path)).toBe(realpathSync(repoPaths[index]))
    }
    const registeredPaths = ids.map((repo) => repo.path)
    await electronApp.evaluate((_, paths) => {
      const allowedPaths = Reflect.get(globalThis, '__gitlabSyntheticRepoPaths')
      if (!Array.isArray(allowedPaths)) {
        throw new Error('Synthetic GitLab repository selector is missing')
      }
      allowedPaths.splice(0, allowedPaths.length, ...paths)
    }, registeredPaths)
    await page.evaluate(
      async (repoIds) => {
        window.__store!.getState().updateSettings({
          uiLanguage: 'en',
          defaultTaskSource: 'gitlab',
          visibleTaskProviders: ['github', 'gitlab'],
          defaultRepoSelection: repoIds
        })
        await window.__store!.getState().refreshPreflightStatus({ force: true })
        window.__store!.getState().openTaskPage({ taskSource: 'gitlab' })
      },
      ids.map((repo) => repo.id)
    )
    await page.getByRole('button', { name: 'External trackers' }).click()
    await page.getByRole('button', { name: 'MRs', exact: true }).click()
    const sourceState = await page.evaluate(
      (paths) => ({
        sourceButtons: [...document.querySelectorAll('[data-task-source]')].map((element) => ({
          source: element.getAttribute('data-task-source'),
          pressed: element.getAttribute('aria-pressed'),
          disabled: element.hasAttribute('disabled')
        })),
        repoRows: window
          .__store!.getState()
          .repos.filter((repo) => paths.includes(repo.path))
          .map((repo) => ({
            id: repo.id,
            path: repo.path,
            kind: repo.kind,
            executionHostId: repo.executionHostId,
            gitRemoteIdentity: repo.gitRemoteIdentity,
            upstream: repo.upstream
          })),
        selectedRepoIds: window.__store!.getState().settings?.defaultRepoSelection,
        requestedTaskSource: window.__store!.getState().taskPageData?.taskSource,
        syntheticGitlabInstalled: window.__store!.getState().preflightStatus?.glab?.installed,
        projectPickerText: document.querySelector('[aria-label="Select projects"]')?.textContent,
        noProjectMessageVisible: document.body.innerText.includes('No projects'),
        providerAuthNeededVisible: document.body.innerText.includes('provider auth needed')
      }),
      registeredPaths
    )
    writeFileSync(
      path.join(evidenceDir, 'gitlab-visible-source-state.json'),
      `${JSON.stringify(sourceState, null, 2)}\n`
    )
    await captureHiddenGitScreenshot(page, evidenceDir, 'gitlab-before-synthetic-mrs.png')
    expect(sourceState.providerAuthNeededVisible).toBe(false)
    const readCalls = async (): Promise<string> =>
      electronApp.evaluate(() =>
        JSON.stringify(Reflect.get(globalThis, '__gitlabSyntheticCalls') ?? [])
      )
    await expect(page.getByText('Synthetic MR A', { exact: true })).toBeVisible()
    await expect(page.getByText('Synthetic MR B', { exact: true })).toBeVisible()
    const initialCalls = await readCalls()
    writeFileSync(receiptPath, `${initialCalls}\n`)
    expect(initialCalls).toContain(
      JSON.stringify({ method: 'listMRs', repoPath: registeredPaths[0] })
    )
    expect(initialCalls).toContain(
      JSON.stringify({ method: 'listMRs', repoPath: registeredPaths[1] })
    )
    await electronApp.evaluate(() => {
      const calls = Reflect.get(globalThis, '__gitlabSyntheticCalls')
      if (!Array.isArray(calls)) {
        throw new Error('Synthetic GitLab call ledger is missing')
      }
      calls.length = 0
    })
    await page.getByRole('combobox', { name: 'Select projects' }).click()
    const projectMenu = page
      .getByRole('dialog')
      .filter({ has: page.getByPlaceholder('Search projects...') })
    await projectMenu
      .getByRole('button', { name: `tracker-b ${registeredPaths[1]}`, exact: true })
      .click()
    await expect(page.getByText('Synthetic MR B', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Synthetic MR A', { exact: true })).toBeVisible()
    const selectedCall = JSON.stringify({ method: 'listMRs', repoPath: registeredPaths[0] })
    const excludedCall = JSON.stringify({ method: 'listMRs', repoPath: registeredPaths[1] })
    await expect.poll(readCalls).toContain(selectedCall)
    const selectedCalls = await readCalls()
    expect(selectedCalls).not.toContain(excludedCall)
    writeFileSync(receiptPath, `${initialCalls}\n${selectedCalls}\n`)
    await page.keyboard.press('Escape')
    await expect(projectMenu).toBeHidden()
    await page.getByRole('button', { name: /Synthetic MR A/ }).click()
    const mrDialog = page.getByRole('dialog')
    await expect(mrDialog.getByText('team/tracker-a', { exact: false })).toBeVisible()
    await expect(mrDialog.getByText('feature/a → main', { exact: true })).toBeVisible()
    await expect(mrDialog.getByText('Synthetic description with linked issue #7')).toBeVisible()
    await expect(mrDialog.getByRole('button', { name: 'Open in GitLab' })).toBeVisible()
    await expect(mrDialog.getByRole('button', { name: 'Create workspace' })).toBeVisible()
    await mrDialog.getByRole('tab', { name: 'Conversation' }).click()
    await expect(mrDialog.getByText('Synthetic discussion')).toBeVisible()
    await mrDialog.getByRole('tab', { name: 'Files' }).click()
    const filesTab = mrDialog.getByRole('tabpanel', { name: /Files/ })
    await expect(filesTab.getByRole('option', { name: 'src/feature.ts' })).toHaveCount(1)
    await expect(filesTab.getByText('Diff content unavailable.')).toBeVisible()
    await mrDialog.getByRole('tab', { name: 'Pipeline' }).click()
    await expect(mrDialog.getByText('synthetic-check')).toBeVisible()
    await expect
      .poll(readCalls)
      .toContain(
        JSON.stringify({ method: 'workItemDetails', repoPath: registeredPaths[0], iid: 11 })
      )
    writeFileSync(receiptPath, `${initialCalls}\n${await readCalls()}\n`)
    await captureHiddenGitScreenshot(page, evidenceDir, 'gitlab-selected-project-mr.png')
    const hiddenAfter = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
    writeFileSync(
      path.join(evidenceDir, 'gitlab-trackers-hidden-page-errors.json'),
      `${JSON.stringify({ hiddenBefore, hiddenAfter, pageErrors }, null, 2)}\n`
    )
    expect(pageErrors).toEqual([])
    expect(hiddenAfter).toBe(true)
  })
})
