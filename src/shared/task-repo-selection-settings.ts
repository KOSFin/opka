/** Persisted provider selections use repo IDs, which identify host-specific checkouts. */
export type TaskRepoSelectionSettings = {
  /** Legacy GitHub selection: null = all; string[] = selected repo IDs. */
  defaultRepoSelection: string[] | null
  /** null = sticky all; arrays freeze the selected projects and their execution hosts. */
  defaultRepoSelections?: Record<string, Partial<Record<'github' | 'gitlab', string[] | null>>>
}
