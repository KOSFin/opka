import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export function ProjectTaskFilters({
  mode,
  setMode,
  repo,
  setRepo,
  source,
  setSource,
  repositories,
  sources,
  archived,
  setArchived,
  attention,
  setAttention
}: {
  mode: 'board' | 'list' | 'tree'
  setMode: (mode: 'board' | 'list' | 'tree') => void
  repo: string
  setRepo: (repo: string) => void
  source: string
  setSource: (source: string) => void
  repositories: string[]
  sources: string[]
  archived: boolean
  setArchived: (value: boolean) => void
  attention: boolean
  setAttention: (value: boolean) => void
}) {
  return (
    <details className="group flex-1">
      <summary className="cursor-pointer">View & filters</summary>
      <div className="flex flex-wrap items-center gap-2 py-2">
        {(['board', 'list', 'tree'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? 'secondary' : 'ghost'}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {value}
          </Button>
        ))}
        {repositories.length > 1 && (
          <Select value={repo} onValueChange={setRepo}>
            <SelectTrigger aria-label="Filter repository">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">All repositories</SelectItem>
              {repositories.map((alias) => (
                <SelectItem key={alias} value={alias}>
                  {alias}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {sources.length > 1 && (
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger aria-label="Filter source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">All sources</SelectItem>
              {sources.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          size="sm"
          variant={archived ? 'secondary' : 'ghost'}
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          Include archived
        </Button>
        <Button
          size="sm"
          variant={attention ? 'secondary' : 'ghost'}
          aria-pressed={attention}
          onClick={() => setAttention(!attention)}
        >
          Needs my decision
        </Button>
      </div>
    </details>
  )
}
