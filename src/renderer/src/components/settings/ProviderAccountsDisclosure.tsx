import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../ui/button'

export function ProviderAccountsDisclosure({
  title,
  icon,
  description,
  searchQuery,
  children
}: {
  title: string
  icon: ReactNode
  description: string
  searchQuery: string
  children: ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const open = expanded || searchQuery.trim().length > 0
  return (
    <div className="space-y-1" data-provider-accounts={title}>
      <Button
        variant="ghost"
        className="w-full justify-start"
        aria-expanded={open}
        onClick={() => setExpanded((value) => !value)}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {icon}
        {title}
      </Button>
      <p className="pl-12 text-xs text-muted-foreground">{description}</p>
      <div hidden={!open} className="pt-3">
        {children}
      </div>
    </div>
  )
}
