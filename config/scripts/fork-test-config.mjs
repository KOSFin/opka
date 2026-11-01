import { globSync } from 'node:fs'

/** Keep each runtime/measurement project's existing discovery and exclusion boundaries. */
export function applyForkTestSelection(config, files, root) {
  const selected = new Set(files)
  const narrow = (options) => ({
    ...options,
    include: globSync(options.include ?? [], { cwd: root, exclude: options.exclude ?? [] })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => selected.has(file))
  })
  return {
    ...config,
    test: {
      ...narrow(config.test),
      ...(config.test.projects
        ? {
            projects: config.test.projects.map((project) => ({
              ...project,
              test: narrow(project.test)
            }))
          }
        : {})
    }
  }
}
