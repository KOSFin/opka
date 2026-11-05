export class CodexNativeAffinityCapacityError extends Error {
  constructor() {
    super(
      'Native conversation affinity capacity is busy; finish retained work before starting another turn.'
    )
  }
}
