import type { ProjectTaskWorkflow } from '../../../../shared/project-task-workflow'

export function ProjectTaskRecordedEvents({ events }: { events: ProjectTaskWorkflow['events'] }) {
  return (
    <>
      <h3 className="text-sm font-medium">Recorded runtime events</h3>
      <p className="text-xs text-muted-foreground">
        Most recent 200 events; Markdown activity is an export, not proof of current liveness.
      </p>
      {events.map((event) => (
        <div key={event.sequence} className="border-b pb-2 text-sm">
          <p>
            {event.kind} <span className="text-xs text-muted-foreground">{event.createdAt}</span>
          </p>
          <p className="whitespace-pre-wrap break-words text-muted-foreground">{event.detail}</p>
        </div>
      ))}
    </>
  )
}
