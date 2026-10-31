import { useId } from 'react'
import type { AccountPoolPolicy } from '../../../../shared/account-pool-policy'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type Member = AccountPoolPolicy['members'][number]

export function AccountPoolMemberSettings({
  member,
  accountLabel,
  balanced,
  disabled,
  onChange
}: {
  member: Member
  accountLabel: string
  balanced: boolean
  disabled: boolean
  onChange: (member: Member) => void
}): React.JSX.Element {
  const id = useId()
  const fields: ('priority' | 'weight')[] = balanced ? ['priority', 'weight'] : ['priority']
  return (
    <>
      <div className="flex items-center gap-2">
        <Label htmlFor={`${id}-role`}>Role</Label>
        <Select
          value={member.role}
          disabled={disabled}
          onValueChange={(role) => {
            if (role === 'primary' || role === 'reserve' || role === 'manual') {
              onChange({ ...member, role })
            }
          }}
        >
          <SelectTrigger id={`${id}-role`} aria-label={`${accountLabel} pool role`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="primary">Primary</SelectItem>
            <SelectItem value="reserve">Reserve</SelectItem>
            <SelectItem value="manual">Manual only</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {fields.map((field) => (
        <div key={field} className="flex items-center gap-2">
          <Label htmlFor={`${id}-${field}`}>{field === 'priority' ? 'Priority' : 'Weight'}</Label>
          <Input
            id={`${id}-${field}`}
            aria-label={`${accountLabel} ${field}`}
            type="number"
            min={1}
            max={field === 'priority' ? 1000 : 100}
            value={member[field]}
            disabled={disabled}
            onChange={(event) => {
              const value = Number(event.target.value)
              const max = field === 'priority' ? 1000 : 100
              if (Number.isInteger(value) && value >= 1 && value <= max) {
                onChange({ ...member, [field]: value })
              }
            }}
          />
        </div>
      ))}
    </>
  )
}
