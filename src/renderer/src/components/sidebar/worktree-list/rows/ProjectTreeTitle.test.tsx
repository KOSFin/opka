import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectTreeTitle } from './ProjectTreeTitle'

it('keeps user-selected repository icons while labelling the row as a repository', () => {
  const markup = renderToStaticMarkup(
    <ProjectTreeTitle
      label="api"
      kind="repository"
      collapsed={false}
      collapsible
      repoIcon={{ type: 'lucide', name: 'Database' }}
    />
  )
  expect(markup).toContain('lucide-database')
  expect(markup).toContain('>Repository</span>')
})

it('exposes opening the whole project separately from the tree collapse affordance', () => {
  const markup = renderToStaticMarkup(
    <ProjectTreeTitle label="Career" kind="project" collapsed collapsible onOpen={() => {}} />
  )
  expect(markup).toContain('aria-label="Open project Career"')
  expect(markup).toContain('data-repo-header-collapse-affordance=""')
  expect(markup).toContain('-rotate-90')
})

it('shows a repository path without a confusing Git or Root Git badge', () => {
  const markup = renderToStaticMarkup(
    <ProjectTreeTitle label="embedded/module" kind="repository" collapsed collapsible />
  )
  expect(markup).toContain('embedded/module')
  expect(markup).not.toContain('Root Git')
  expect(markup).toContain('class="sr-only">Repository')
})
