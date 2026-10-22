export async function repairAcceptanceProject(page, input) {
  return page.evaluate(async ({ environmentId, root, folderId }) => {
    const call = async (method, params) => {
      const response = environmentId
        ? await window.api.runtimeEnvironments.call({ selector: environmentId, method, params })
        : await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    }
    const before = await call('folderWorkspace.list')
    const folder = before.folderWorkspaces.find((entry) => entry.id === folderId)
    if (!folder || folder.folderPath !== root) {
      throw new Error('Acceptance project identity or location changed; repair refused')
    }
    const groups = (await call('projectGroup.list')).groups
    const owner = groups.find((entry) => entry.id === folder.projectGroupId)
    if (!owner || !['LOCAL — Fork acceptance', 'REMOTE — Fork acceptance'].includes(owner.name)) {
      throw new Error('Unknown project owner; repair refused')
    }
    const reposBefore = (await call('repo.list')).repos.map((entry) => entry.id).sort()
    let merged = 0
    for (const group of groups) {
      if (
        group.id !== owner.id &&
        !group.parentGroupId &&
        group.parentPath === root &&
        group.name === owner.name &&
        group.createdFrom === 'folder-scan'
      ) {
        await call('projectGroup.merge', { sourceId: group.id, targetId: owner.id })
        merged++
      }
    }
    const after = await call('folderWorkspace.list')
    const reposAfter = (await call('repo.list')).repos.map((entry) => entry.id).sort()
    if (
      JSON.stringify(before.folderWorkspaces.map((entry) => entry.id).sort()) !==
        JSON.stringify(after.folderWorkspaces.map((entry) => entry.id).sort()) ||
      JSON.stringify(reposBefore) !== JSON.stringify(reposAfter)
    ) {
      throw new Error('Project repair changed workspace identities')
    }
    const catalog = await call('projectTask.catalog')
    const homes = catalog.projects.filter((entry) => entry.root === root)
    if (homes.length !== 1 || homes[0].state !== 'configured') {
      throw new Error('Expected one configured acceptance project')
    }
    return { merged, folderIdsPreserved: true, repoIdsPreserved: true, projectCount: homes.length }
  }, input)
}
