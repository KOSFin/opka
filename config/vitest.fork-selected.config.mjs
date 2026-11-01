import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyForkTestSelection } from './scripts/fork-test-config.mjs'

const lane = process.env.OPKA_FORK_TEST_LANE
if (!['root', 'mobile', 'render'].includes(lane)) {
  throw new Error('Missing fork test lane')
}
const plan = JSON.parse(readFileSync(resolve('out/opka-ci/fork-test-selection.json'), 'utf8'))
if (plan.schema !== 1 || !Array.isArray(plan.lanes?.[lane])) {
  throw new Error('Invalid fork test plan')
}
const base =
  lane === 'mobile'
    ? (await import('../mobile/vitest.config.ts')).default
    : (await import('./vitest.config.ts')).default
const files = plan.lanes[lane].map((file) =>
  lane === 'mobile' ? file.slice('mobile/'.length) : file
)
export default applyForkTestSelection(base, files, base.root ?? process.cwd())
