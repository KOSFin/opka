export class CodexTurnBoundaryError extends Error {
  constructor() {
    super(
      'The host cannot bind this child request to the current account turn; no request was sent.'
    )
  }
}
