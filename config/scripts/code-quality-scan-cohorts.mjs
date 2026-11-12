export function planTypeAwareCohorts(files) {
  const cohorts = [[], [], []]
  for (const file of files) {
    const index = file.startsWith('src/renderer/') ? 0 : file.startsWith('mobile/') ? 1 : 2
    cohorts[index].push(file)
  }
  return cohorts.filter((cohort) => cohort.length > 0)
}

export function runCodeQualityScan(root, scan, files, runScan) {
  if (!scan.args.includes('--type-aware')) {
    return { diagnostics: runScan(root, scan, files), errors: [] }
  }
  const diagnostics = []
  const errors = []
  // Separate processes release each TypeScript project graph before loading the next cohort.
  for (const cohort of planTypeAwareCohorts(files)) {
    try {
      for (const diagnostic of runScan(
        root,
        { ...scan, args: [...scan.args, '--threads=1'] },
        cohort
      )) {
        diagnostics.push(diagnostic)
      }
    } catch (error) {
      errors.push(error)
    }
  }
  return { diagnostics, errors }
}
